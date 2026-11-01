/** A chart's file source, pure: the parser (JSONL and CSV as the contract says records become points — however the
 *  bytes are split into pages), the reader (pages from where it is, a file truncated, replaced or rewritten — of the
 *  same length, longer, or in its middle with its first and last bytes kept — read again from its start; a missing
 *  file and a failure asked for again; an answer of before a reset ignored) and the drawing of many points (bounded by
 *  the plot's width, spikes kept, gaps never joined across columns, the cursor on raw points). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32 as zcrc32 } from 'node:zlib'
import type { UiChartSource, UiChartSourcePage } from '@oasis-code/contract'
import { crc32, csvFields, SourceParser } from '../src/state/uiChartSource.ts'
import { ChartFeed, VERIFY_MIN_MS, type FeedDeps, type PageAnswer, type PageRequest } from '../src/state/uiChartFeed.ts'
import { columnDotAt, columnGeometry, columnLatest, columnValuesAt, nearestColumnX, stepColumnX, columnXs, columnTablePage, type ColumnSeries } from '../src/state/uiChartColumns.ts'

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s)
const jsonl = (over: Partial<UiChartSource> = {}): UiChartSource => ({ path: 'train.jsonl', format: 'jsonl', x: 'step', series: [{ id: 'loss', label: 'Loss', column: 'loss' }, { id: 'val', label: 'Val', column: 'val_loss', line_style: 'dashed' }], ...over })
const csv = (over: Partial<UiChartSource> = {}): UiChartSource => ({ path: 'train.csv', format: 'csv', x: 'step', series: [{ id: 'loss', label: 'Loss', column: 'loss' }], ...over })
const pts = (p: SourceParser, i = 0) => Array.from({ length: p.points.columns[i]!.n }, (_, k) => [p.points.columns[i]!.xs[k]!, p.points.columns[i]!.ys[k]!])
/** feed the bytes split at every position given (and whole) */
function parse(source: UiChartSource, text: string | Uint8Array, cuts: number[] = [], axis: 'number' | 'time' = 'number', recordBytes?: number): SourceParser {
  const b = typeof text === 'string' ? bytes(text) : text
  const p = new SourceParser(source, axis, recordBytes)
  let at = 0
  for (const c of [...cuts, b.length]) { p.feed(b.subarray(at, c)); at = c }
  return p
}
/** the same result whole, byte by byte, and cut at every single position */
function invariant(source: UiChartSource, text: string, recordBytes?: number): SourceParser {
  const b = bytes(text)
  const whole = parse(source, b, [], 'number', recordBytes)
  const want = JSON.stringify([source.series.map((_, i) => pts(whole, i)), whole.points.stats])
  const each = parse(source, b, Array.from({ length: b.length }, (_, i) => i), 'number', recordBytes)
  assert.equal(JSON.stringify([source.series.map((_, i) => pts(each, i)), each.points.stats]), want, 'byte by byte')
  for (let c = 0; c <= b.length; c += 1) {
    const two = parse(source, b, [c], 'number', recordBytes)
    assert.equal(JSON.stringify([source.series.map((_, i) => pts(two, i)), two.points.stats]), want, `cut at ${c}`)
  }
  return whole
}

test('CRC-32: the IEEE check value, continued across pieces as zlib continues it', () => {
  assert.equal(crc32(bytes('123456789')), 0xcbf43926)
  const data = bytes('{"step":1,"loss":0.5}\n'.repeat(1000))
  assert.equal(crc32(data), zcrc32(data))
  assert.equal(crc32(data.subarray(700), crc32(data.subarray(0, 700))), zcrc32(data))
  assert.equal(crc32(new Uint8Array(0)), 0)
})

test('JSONL: records end at a newline; CRLF, a BOM split across pages, UTF-8 split anywhere; bad lines skipped, the next one read', () => {
  const text = '\ufeff{"step":1,"loss":0.5,"note":"汉字🙂"}\r\n{"step":2,"loss":-3e-7}\nnot json\n[1,2]\n\n{"step":3,"loss":0.25,"val_loss":0.4}\n{"step":4,"loss":0.2'
  const p = invariant(jsonl(), text)
  assert.deepEqual(pts(p, 0), [[1, 0.5], [2, -3e-7], [3, 0.25]], 'the last line has no newline yet: it waits')
  assert.deepEqual(pts(p, 1), [[3, 0.4]])
  assert.equal(p.points.stats.badRecords, 2)
  p.feed(bytes('5}\n'))
  assert.deepEqual(pts(p, 0).at(-1), [4, 0.25])
})

test('JSONL values: null and non-numbers are gaps, an absent field is no point (sparse columns stay lines), never zero', () => {
  const p = parse(jsonl(), [
    '{"step":0,"loss":1}', '{"step":1,"loss":null}', '{"step":2,"loss":"nan"}', '{"step":3,"loss":true}', '{"step":4,"loss":0.9}',
    '{"step":5}', '{"step":10,"loss":0.8,"val_loss":0.85}', '{"step":20,"loss":0.7,"val_loss":0.75}', '',
  ].join('\n'))
  const loss = pts(p, 0)
  assert.deepEqual(loss.map(([x]) => x), [0, 1, 2, 3, 4, 10, 20], 'a record without the field gives no point')
  assert.ok(loss.slice(1, 4).every(([, y]) => Number.isNaN(y)), 'null, text and true are gaps')
  assert.deepEqual(pts(p, 1), [[10, 0.85], [20, 0.75]], 'the validation line has its own two points, not 6 points with gaps')
  assert.equal(p.points.columns[1]!.finite, 2)
  assert.equal(p.points.yMin, 0.7)
  assert.equal(p.points.yMax, 1)
})

test('x: a finite number, strictly increasing per series (a restart from an earlier step is skipped); time is whole epoch ms', () => {
  const p = parse(jsonl(), '{"step":1,"loss":1}\n{"step":"2","loss":2}\n{"loss":3}\n{"step":3,"loss":3}\n{"step":2,"loss":9}\n{"step":3,"loss":9}\n{"step":4,"val_loss":1}\n{"step":3.5,"loss":4}\n')
  assert.deepEqual(pts(p, 0), [[1, 1], [3, 3], [3.5, 4]])
  assert.deepEqual(pts(p, 1), [[4, 1]], 'each series keeps its own order')
  assert.equal(p.points.stats.noX, 2)
  assert.equal(p.points.stats.outOfOrder, 2)
  const t = parse(jsonl(), '{"step":1760000000000,"loss":1}\n{"step":1760000000000.5,"loss":2}\n{"step":9e15,"loss":3}\n{"step":1760000060000,"loss":4}\n', [], 'time')
  assert.deepEqual(pts(t, 0), [[1760000000000, 1], [1760000060000, 4]])
})

test('a record longer than the bound is skipped up to its end; the lines after it are read', () => {
  const long = `{"step":2,"loss":2,"pad":"${'x'.repeat(100)}"}`
  const p = invariant(jsonl(), `{"step":1,"loss":1}\n${long}\n{"step":3,"loss":3}\n`, 64)
  assert.deepEqual(pts(p, 0), [[1, 1], [3, 3]])
  assert.equal(p.points.stats.badRecords, 1)
})

test('CSV: header names trimmed, quoted commas and line breaks, "" a quote, empty cell no point, text a gap', () => {
  assert.deepEqual(csvFields('1,"a, ""b""\nc",,x"y'), ['1', 'a, "b"\nc', '', 'x"y'])
  const src = csv({ series: [{ id: 'loss', label: 'L', column: 'loss' }, { id: 'v', label: 'V', column: 'val loss' }] })
  const p = invariant(src, '\ufeffstep, loss ,"val loss",note\r\n1,0.5,,"a, b"\r\n2,nan,0.7,"multi\nline ""quoted"""\n3,0.25,,x\n,9,9,no x\n')
  assert.deepEqual(pts(p, 0).map(([x, y]) => [x, Number.isNaN(y) ? 'gap' : y]), [[1, 0.5], [2, 'gap'], [3, 0.25]])
  assert.deepEqual(pts(p, 1), [[2, 0.7]])
  assert.equal(p.points.stats.noX, 1)
  const missing = parse(csv({ x: 'epoch' }), 'step,loss\n1,2\n')
  assert.deepEqual(missing.points.missingColumns, ['epoch'])
})

test('CSV framing reads quotes as the fields do: a quote inside an unquoted field is text; an overlong quoted record ends where its quotes say, however it is paged', () => {
  // a stray quote in an unquoted field neither opens a field nor holds the rows after it
  const stray = invariant(csv(), 'step,loss,note\n1,2,a"b\n2,3,ok\n')
  assert.deepEqual(pts(stray), [[1, 2], [2, 3]])
  // an overlong record whose quoted field holds a line break and text that looks like a row: skipped whole, the row
  // inside it is no point, the row after it is
  const a = 'step,loss,note\n1,1,"12345678901234567890'
  const b = '\n2,999,x\n"\n3,3,z\n'
  const whole = parse(csv(), a + b, [], 'number', 16)
  const split = parse(csv(), a + b, [bytes(a).length], 'number', 16)
  assert.deepEqual(pts(whole), [[3, 3]])
  assert.deepEqual(pts(split), [[3, 3]])
  assert.equal(split.points.stats.badRecords, 1)
  invariant(csv(), a + b, 16)
})

// ---------------------------------------------------------------- the reader, against a file in memory

/** A file as the server reads it (agent/ui_chart_sources.ts localPage): identity, size, time; one page up to the size
 *  at the request, the anchors, the prefix's CRC on request. */
class MemFile {
  data = new Uint8Array(0)
  id = 1
  mtime = 1
  exists = true
  write(text: string) { this.data = bytes(text); this.mtime += 1 }
  append(text: string) { const b = bytes(text); const n = new Uint8Array(this.data.length + b.length); n.set(this.data); n.set(b, this.data.length); this.data = n; this.mtime += 1 }
  replace(text: string) { this.id += 1; this.write(text) }
  page(q: PageRequest): Extract<UiChartSourcePage, { status: 'ok' }> {
    const size = this.data.length, off = q.offset
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
    const data = off < size ? this.data.subarray(off, Math.min(size, off + q.limit)) : new Uint8Array(0)
    return {
      status: 'ok', file_id: `1:${this.id}`, size, mtime_ms: this.mtime, offset: off, next_offset: off + data.length, eof: off + data.length >= size,
      data: b64(data), head: b64(this.data.subarray(0, Math.min(64, size))), anchor: off <= size ? b64(this.data.subarray(Math.max(0, off - 64), off)) : null,
      crc: q.verify && off <= size ? zcrc32(this.data.subarray(0, off)) : null,
    }
  }
}

/** A clock and timers driven by the test; requests answered by `answer` (the file, unless a test says otherwise). */
function harness(file: MemFile, source = jsonl(), pageBytes = 64) {
  let now = 0
  const timers: { at: number; fn: () => void; id: number }[] = []
  let ids = 0
  const requests: PageRequest[] = []
  let answer: (q: PageRequest) => Promise<PageAnswer> = async (q) => (file.exists ? { kind: 'page', page: file.page(q) } : { kind: 'missing', reason: 'no file' })
  const deps: FeedDeps = {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, id: ++ids }; timers.push(t); return t.id },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) },
    fetchPage: (q) => { requests.push(q); return answer(q) },
  }
  const feed = new ChartFeed(source, 'number', 1, deps, pageBytes)
  /** run every timer due up to `ms` from now (each poll's answer settled before the next) */
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = Math.max(now, t.at)
      t.fn()
      for (let k = 0; k < 5; k += 1) await Promise.resolve()
    }
    now = end
  }
  const later = <T>(ms: number, value: () => T) => new Promise<T>((r) => { deps.setTimer(() => r(value()), ms) })
  return { feed, requests, advance, setAnswer: (f: typeof answer) => { answer = f }, timers, later }
}
const lossOf = (feed: ChartFeed) => { const c = feed.snapshot().points.columns[0]!; return Array.from({ length: c.n }, (_, i) => c.ys[i]) }
const lines = (from: number, to: number, v = (i: number) => i / 10) => Array.from({ length: to - from }, (_, k) => `{"step":${from + k},"loss":${v(from + k)}}\n`).join('')

test('the reader appends: pages from where it is, bounded; a half line waits; one request at a time', async () => {
  const file = new MemFile()
  file.write(lines(0, 20))
  const h = harness(file)
  h.feed.start()
  await h.advance(50)
  assert.equal(h.feed.snapshot().points.columns[0]!.n, 20)
  assert.ok(h.requests.every((q) => q.limit === 64), 'every page is bounded')
  assert.ok(h.requests.length >= Math.ceil(file.data.length / 64))
  file.append('{"step":20,"loss":2')
  await h.advance(1000)
  assert.equal(h.feed.snapshot().points.columns[0]!.n, 20)
  file.append('.5}\n')
  await h.advance(1000)
  assert.deepEqual(lossOf(h.feed).slice(-1), [2.5])
  assert.equal(h.feed.snapshot().resets, 0)
  assert.equal(h.feed.snapshot().offset, file.data.length)
})

test('a truncated file, another file renamed over the path, and a rewrite longer than before are read from the start', async () => {
  const file = new MemFile()
  file.write(lines(0, 10))
  const h = harness(file)
  h.feed.start()
  await h.advance(100)
  // truncated, then written again past the old size before the next poll (the same identity)
  file.write(lines(0, 30, (i) => 100 + i))
  await h.advance(1500)
  assert.equal(h.feed.snapshot().resets, 1)
  assert.deepEqual(lossOf(h.feed).slice(0, 2), [100, 101])
  assert.equal(lossOf(h.feed).length, 30)
  // an atomic replace: same size and bytes but another file
  file.replace(new TextDecoder().decode(file.data))
  await h.advance(1500)
  assert.equal(h.feed.snapshot().resets, 2)
  // shorter (truncated)
  file.write(lines(0, 3, () => 7))
  await h.advance(1500)
  assert.deepEqual(lossOf(h.feed), [7, 7, 7])
  assert.equal(h.feed.snapshot().generation, 3)
})

test('a rewrite of the same length is found by the prefix check its unchanged size and new time ask for', async () => {
  const file = new MemFile()
  file.write(lines(0, 40))
  const h = harness(file)
  h.feed.start()
  await h.advance(100)
  // change one value in the middle: same length, same first and last bytes
  const text = new TextDecoder().decode(file.data).replace('"step":20,"loss":2}', '"step":20,"loss":9}')
  file.write(text)
  // seen at the next poll (not grown, a new time), checked at the one after
  await h.advance(2500)
  assert.equal(h.feed.snapshot().resets, 1)
  await h.advance(1500)
  assert.equal(lossOf(h.feed)[20], 9)
  assert.ok(h.requests.some((q) => q.verify))
})

test('a rewrite of the middle that keeps the first and last bytes while the file grows is found by the periodic prefix check; polls with nothing new never hash', async () => {
  const file = new MemFile()
  file.write(lines(0, 40))
  const h = harness(file)
  h.feed.start()
  await h.advance(100)
  await h.advance(3000)
  const quiet = h.requests.filter((q) => q.verify).length
  assert.equal(quiet, 0, 'nothing changed: no prefix check before the interval')
  // rewrite the middle (keeps head and tail) and append in the same breath: anchors match, the file grew
  file.write(new TextDecoder().decode(file.data).replace('"step":20,"loss":2}', '"step":20,"loss":8}') + lines(40, 41))
  await h.advance(1500)
  assert.equal(h.feed.snapshot().resets, 0, 'not seen yet (documented: found by the next prefix check)')
  await h.advance(VERIFY_MIN_MS)
  assert.equal(h.feed.snapshot().resets, 1)
  await h.advance(1500)
  assert.equal(lossOf(h.feed)[20], 8)
  assert.equal(lossOf(h.feed).length, 41)
  // while appending continuously, the prefix check runs at most once per interval and agrees (no false reset)
  const before = h.requests.filter((q) => q.verify).length
  for (let i = 0; i < 30; i += 1) { file.append(lines(41 + i, 42 + i)); await h.advance(1000) }
  const checks = h.requests.filter((q) => q.verify).length - before
  assert.ok(checks >= 2 && checks <= 4, `checks while appending for 30 s: ${checks}`)
  assert.equal(h.feed.snapshot().resets, 1)
})

test('a missing file is waited for; a failure is retried with a growing wait; an answer of before a reset changes nothing', async () => {
  const file = new MemFile()
  file.exists = false
  const h = harness(file)
  h.feed.start()
  await h.advance(10)
  assert.equal(h.feed.snapshot().status, 'missing')
  file.exists = true
  file.write(lines(0, 3))
  await h.advance(2000)
  assert.equal(h.feed.snapshot().status, 'live')
  assert.equal(lossOf(h.feed).length, 3)
  h.setAnswer(async () => ({ kind: 'error', message: 'disconnected' }))
  await h.advance(1000)
  assert.equal(h.feed.snapshot().status, 'retrying')
  const n = h.requests.length
  await h.advance(1500)
  assert.ok(h.requests.length - n <= 2, 'backs off')
  h.setAnswer(async (q) => ({ kind: 'page', page: file.page(q) }))
  file.append(lines(3, 5))
  await h.advance(20_000)
  assert.equal(h.feed.snapshot().status, 'live')
  assert.equal(lossOf(h.feed).length, 5)
  // a slow answer arrives after the feed was let go: nothing changes
  let release!: (a: PageAnswer) => void
  h.setAnswer(() => new Promise((r) => { release = r }))
  await h.advance(1000)
  const snap = h.feed.snapshot()
  h.feed.dispose()
  release({ kind: 'page', page: { ...file.page({ revision: 1, offset: 0, limit: 64, verify: false, signal: new AbortController().signal }), file_id: 'other' } })
  await h.advance(10)
  assert.equal(h.feed.snapshot(), snap)
})

// ---------------------------------------------------------------- drawing many points

function columnsOf(values: number[][], start = 0): ColumnSeries[] {
  const p = new SourceParser({ format: 'jsonl', x: 'x', series: values.map((_, i) => ({ id: `s${i}`, label: `S${i}`, column: `v${i}` })) }, 'number')
  const n = Math.max(...values.map((v) => v.length))
  let text = ''
  for (let i = 0; i < n; i += 1) {
    const o: Record<string, unknown> = { x: start + i }
    values.forEach((v, j) => { if (i < v.length) o[`v${j}`] = Number.isNaN(v[i]!) ? null : v[i] })
    text += `${JSON.stringify(o)}\n`
  }
  p.feed(bytes(text))
  return values.map((_, i) => ({ id: `s${i}`, label: `S${i}`, dashed: i === 1, color: i, col: p.points.columns[i]! }))
}
const extentOf = (s: ColumnSeries[]) => {
  let yMin = Infinity, yMax = -Infinity
  for (const c of s) for (let i = 0; i < c.col.n; i += 1) { const v = c.col.ys[i]!; if (v < yMin) yMin = v; if (v > yMax) yMax = v }
  return { xMin: Math.min(...s.map((c) => c.col.xs[0]!)), xMax: Math.max(...s.map((c) => c.col.xs[c.col.n - 1]!)), yMin, yMax }
}
const pathYs = (path: string) => (path.match(/[ML]-?[\d.]+ -?[\d.]+/g) ?? []).map((m) => Number(m.split(' ')[1]))

test('100,000 points in a 600-pixel plot: at most 10 points per column per series, both spikes drawn, the latest raw', () => {
  const n = 100_000
  const a = Array.from({ length: n }, (_, i) => Math.sin(i / 500) + (i === 31_337 ? 40 : i === 77_777 ? -40 : 0))
  const s = columnsOf([a, a.map((v) => v / 2)])
  const g = columnGeometry(s, extentOf(s), 'number', 600, 148)
  for (const l of g.lines) assert.ok(l.drawn <= 600 * 10 + 10, `drawn ${l.drawn}`)
  const ys = pathYs(g.lines[0]!.path)
  assert.equal(Math.min(...ys), columnDotAt(s[0]!, 31_337, g.x, g.y, 600, 148)!.y, 'the upward spike is drawn (the highest point)')
  assert.equal(Math.max(...ys), columnDotAt(s[0]!, 77_777, g.x, g.y, 600, 148)!.y, 'the downward spike is drawn (the lowest point)')
  assert.ok(Math.min(...ys) < 15 && Math.max(...ys) > 133)
  assert.equal(g.lines[0]!.latest!.at, n - 1)
  assert.equal(g.points, 2 * n)
  // the raw readout and the cursor's binary searches
  assert.equal(columnLatest(s)[0]!.point!.value, a[n - 1])
  assert.equal(columnValuesAt(s, 31_337)[0]!.point!.value, a[31_337])
  assert.equal(nearestColumnX(s, 31_337.4), 31_337)
  assert.equal(stepColumnX(s, 10, 10), 20)
  assert.equal(stepColumnX(s, null, -1), n - 1)
})

test('many gaps: the drawing stays bounded by the width; a gap between columns is never joined; a point alone is a dot', () => {
  const n = 50_000
  const alt = Array.from({ length: n }, (_, i) => (i % 2 ? Number.NaN : Math.cos(i)))
  const s = columnsOf([alt])
  const g = columnGeometry(s, extentOf(s), 'number', 300, 100)
  assert.ok(g.lines[0]!.drawn <= 300 * 10 + 10, `drawn ${g.lines[0]!.drawn}`)
  assert.ok(g.lines[0]!.marks.length <= 300 * 3, `marks ${g.lines[0]!.marks.length}`)
  // a gap between two stretches far apart: the pen lifts
  const two = columnsOf([[...Array.from({ length: 1000 }, () => 1), Number.NaN, ...Array.from({ length: 1000 }, () => 2)]])
  const g2 = columnGeometry(two, extentOf(two), 'number', 400, 100)
  assert.equal((g2.lines[0]!.path.match(/M/g) ?? []).length, 2)
  // a sparse series: a dot per point
  const few = columnsOf([[1, 2, Number.NaN, 4]])
  assert.equal(columnGeometry(few, extentOf(few), 'number', 400, 100).lines[0]!.marks.length, 3)
})

test('the values table: the xs of every series merged once each, a page at a time, exact numbers', () => {
  const s = columnsOf([[1, 2, 3, 4], [Number.NaN, 5]])
  const all = columnXs(s)
  assert.deepEqual(Array.from(all), [0, 1, 2, 3])
  const page = columnTablePage(s, all, 'number', null, 3)
  assert.equal(page.pages, 2)
  assert.deepEqual(page.cells, [['4', '']])
  assert.deepEqual(columnTablePage(s, all, 'number', 0, 3).cells, [['1', 'no value'], ['2', '5'], ['3', '']])
})

test('an empty file touched or truncated again polls at the normal interval (no prefix to check, no busy loop)', async () => {
  const file = new MemFile()
  file.write('')
  const h = harness(file)
  h.feed.start()
  await h.advance(100)
  for (let i = 0; i < 5; i += 1) { file.write(''); await h.advance(1000) }
  assert.ok(h.requests.length <= 8, `requests in 5 s: ${h.requests.length}`)
  assert.ok(!h.requests.some((q) => q.verify))
})

test('a file growing faster than it is read is still checked on its deadline: a middle rewrite during catch-up is found', async () => {
  const file = new MemFile()
  file.write(lines(0, 400))
  const h = harness(file, jsonl(), 64)
  // each page answer takes 200 ms (a slow link): the reader is never caught up while the writer keeps appending
  h.setAnswer((q) => h.later(200, () => ({ kind: 'page' as const, page: file.page(q) })))
  h.feed.start()
  await h.advance(500)
  file.write(new TextDecoder().decode(file.data).replace('"step":3,"loss":0.3}', '"step":3,"loss":5}'))
  let caughtUp = 0
  for (let i = 0; i < 40 && h.feed.snapshot().resets === 0; i += 1) {
    file.append(lines(400 + i * 50, 450 + i * 50))
    await h.advance(1000)
    if (h.feed.snapshot().caughtUp) caughtUp += 1
  }
  assert.equal(caughtUp, 0, 'never caught up meanwhile')
  assert.equal(h.feed.snapshot().resets, 1, 'found by the deadline check')
})

test('a file only touched over and over is checked at most every few seconds, never in a loop', async () => {
  const file = new MemFile()
  file.write(lines(0, 50))
  const h = harness(file)
  h.feed.start()
  await h.advance(100)
  const n = h.requests.length
  for (let i = 0; i < 20; i += 1) { file.mtime += 1; await h.advance(500) }
  const verifies = h.requests.slice(n).filter((q) => q.verify).length
  assert.ok(h.requests.length - n <= 12, `requests in 10 s: ${h.requests.length - n}`)
  assert.ok(verifies >= 2 && verifies <= 5, `checks in 10 s of touches: ${verifies}`)
  assert.equal(h.feed.snapshot().resets, 0)
})

test('an answer "stale" to a request of an older revision is asked again at once at the revision now known', async () => {
  const file = new MemFile()
  file.write(lines(0, 5))
  const h = harness(file)
  let release!: () => void
  h.setAnswer((q) => (q.revision === 1 ? new Promise((r) => { release = () => r({ kind: 'stale' }) }) : Promise.resolve({ kind: 'page', page: file.page(q) })))
  h.feed.start()
  await h.advance(10)
  h.feed.setRevision(2)
  release()
  await h.advance(100)
  await h.advance(100)
  assert.equal(h.feed.snapshot().status, 'live')
  assert.equal(lossOf(h.feed).length, 5)
  assert.equal(h.requests.at(-1)!.revision, 2)
})

const progressSource = (execution_id?: string): UiChartSource => jsonl({ progress: { completed: 'done', total: 'total', rate: 'rate', eta: 'eta', status: 'status', log: 'log', ...(execution_id ? { execution_id } : {}) } })
test('progress records are bounded partial updates, independent of x; half/bad records keep valid data; null clears', () => {
  const p = new SourceParser(progressSource(), 'number')
  p.feed(bytes('{"done":2,"total":10,"rate":2,"log":"first"}\n{bad}\n{"done":'))
  assert.deepEqual(p.points.progress, { completed: 2, total: 10, rate: 2, logs: ['first'] })
  p.feed(bytes('4,"rate":-1}\n{"rate":null,"log":null}\n'))
  assert.deepEqual(p.points.progress, { completed: 4, total: 10, logs: [] })
  for (let i = 0; i < 10; i++) p.feed(bytes(JSON.stringify({ log: `${i}:` + 'x'.repeat(2200) }) + '\n'))
  assert.equal(p.points.progress.logs.length, 5)
  assert.ok(p.points.progress.logs.every((l) => l.length === 2000))
  p.feed(bytes('{"status":"failed"}\n{"status":"running","done":9}\n'))
  assert.equal((p.points.progress as import('../src/state/uiChartSource.ts').TaskProgress).status, 'failed')
  assert.equal(p.points.progress.completed, 9)
  const csvProgress = parse({ ...progressSource(), format: 'csv' }, 'done,total,rate,log,status\n1,5,2,"a,b",running\n')
  assert.deepEqual(csvProgress.points.progress, { completed: 1, total: 5, rate: 2, logs: ['a,b'], status: 'running' })
})

test('100% is not completion; terminal record stops polling at EOF, preserves loss and logs', async () => {
  const f = new MemFile(); f.write('{"step":1,"loss":2,"done":10,"total":10}\n')
  const h = harness(f, progressSource()); h.feed.start(); await h.advance(100)
  assert.equal(h.feed.snapshot().terminal, false)
  f.append('{"status":"succeeded","log":"saved"}\n')
  await h.advance(2000)
  assert.equal(h.feed.snapshot().terminal, true)
  const n = h.requests.length
  await h.advance(30_000); h.feed.start(); await h.advance(1000)
  assert.equal(h.requests.length, n)
  assert.deepEqual(lossOf(h.feed), [2])
  assert.deepEqual(h.feed.snapshot().points.progress.logs, ['saved'])
})

test('execution wins over a premature success record; disconnect is unknown and failed exit drains tail', async () => {
  const f = new MemFile(); f.write('{"done":3,"status":"succeeded"}\n')
  const h = harness(f, progressSource('x_test'))
  let status: 'running' | 'unknown' | 'failed' = 'running'
  h.setAnswer(async (q) => ({ kind: 'page', page: { ...f.page(q), execution: { status, exit_code: status === 'failed' ? 7 : null } } }))
  h.feed.start(); await h.advance(100)
  assert.equal(h.feed.snapshot().terminal, false)
  status = 'unknown'; await h.advance(1000)
  assert.equal(h.feed.snapshot().execution?.status, 'unknown'); assert.equal(h.feed.snapshot().terminal, false)
  status = 'failed'; f.append('{"step":2,"loss":0.1}\n'); await h.advance(2000)
  assert.equal(h.feed.snapshot().terminal, true)
  assert.equal(h.feed.snapshot().execution?.exit_code, 7)
  assert.deepEqual(lossOf(h.feed), [0.1])
})

test('progress missing/error retains last valid values; a replaced generation does not merge old totals/logs', async () => {
  const f = new MemFile(); f.write('{"done":3,"total":10,"rate":4,"log":"old"}\n')
  const h = harness(f, progressSource()); h.feed.start(); await h.advance(100)
  f.exists = false; await h.advance(1000)
  assert.equal(h.feed.snapshot().points.progress.completed, 3)
  h.setAnswer(async () => ({ kind: 'error', message: 'offline' })); await h.advance(2000)
  assert.deepEqual(h.feed.snapshot().points.progress.logs, ['old'])
  f.exists = true; f.replace('{bad}\n{"done":')
  h.setAnswer(async (q) => ({ kind: 'page', page: f.page(q) })); await h.advance(4000)
  assert.equal(h.feed.snapshot().points.progress.completed, undefined)
  f.append('1}\n'); await h.advance(2000)
  assert.deepEqual(h.feed.snapshot().points.progress, { completed: 1, logs: [] })
})

test('revision and pause abort outstanding progress reads; late responses do not mutate the new view', async () => {
  const f = new MemFile(); f.write('{"done":1}\n')
  const h = harness(f, progressSource())
  let resolve!: (p: PageAnswer) => void
  h.setAnswer(() => new Promise((r) => { resolve = r }))
  h.feed.start(); await h.advance(1)
  const old = h.requests[0]!
  h.feed.setRevision(2)
  assert.equal(old.signal.aborted, true)
  resolve({ kind: 'page', page: f.page(old) }); await Promise.resolve()
  assert.equal(h.feed.snapshot().points.progress.completed, undefined)
  h.feed.pause(); await h.advance(10_000)
  assert.equal(h.requests.length, 1)
  h.feed.dispose()
})

test('a reliable failed execution survives unavailable final file reads and stops polling', async () => {
  const f = new MemFile(); f.write('{"done":3,"log":"last good"}\n')
  const h = harness(f, progressSource('x_test')); h.feed.start(); await h.advance(100)
  h.setAnswer(async () => ({ kind: 'error', message: 'SSH unavailable', execution: { status: 'failed', exit_code: 7 } }))
  await h.advance(1000)
  assert.equal(h.feed.snapshot().terminal, false)
  assert.equal(h.feed.snapshot().execution?.status, 'failed')
  await h.advance(10_000)
  assert.equal(h.feed.snapshot().terminal, true)
  assert.deepEqual(h.feed.snapshot().points.progress.logs, ['last good'])
  const n = h.requests.length; await h.advance(20_000); assert.equal(h.requests.length, n)
})

test('rate/ETA-only and null-only records publish; final read retry can recover after its bounded attempts', async () => {
  const f = new MemFile(); f.write('{"rate":3,"eta":10}\n')
  const h = harness(f, progressSource('x_test')); h.feed.start(); await h.advance(100)
  assert.equal(h.feed.snapshot().points.progress.rate, 3)
  f.append('{"rate":null,"eta":null}\n'); await h.advance(1000)
  assert.equal(h.feed.snapshot().points.progress.rate, undefined)
  h.setAnswer(async () => ({ kind: 'missing', reason: 'temporarily gone', execution: { status: 'succeeded', exit_code: 0 } }))
  await h.advance(10_000); assert.equal(h.feed.snapshot().terminal, true)
  f.append('{"done":4,"log":"final output"}\n')
  h.setAnswer(async (q) => ({ kind: 'page', page: { ...f.page(q), execution: { status: 'succeeded', exit_code: 0 } } }))
  h.feed.retryFinal(); await h.advance(100)
  assert.equal(h.feed.snapshot().terminal, true)
  assert.equal(h.feed.snapshot().points.progress.completed, 4)
  assert.deepEqual(h.feed.snapshot().points.progress.logs, ['final output'])
})

test('known failed execution bounds later network errors without execution to three total final-read attempts', async () => {
  const f = new MemFile(); f.write('{"step":1,"loss":2,"done":3,"log":"last good"}\n')
  const h = harness(f, progressSource('x_test')); h.feed.start(); await h.advance(100)
  const points = h.feed.snapshot().points
  const before = h.requests.length
  let attempts = 0
  h.setAnswer(async () => ++attempts === 1
    ? { kind: 'error', message: 'final file unavailable', execution: { status: 'failed', exit_code: 7 } }
    : { kind: 'error', message: 'network error' })
  await h.advance(1000)
  assert.equal(attempts, 1)
  assert.equal(h.feed.snapshot().terminal, false)
  await h.advance(1000)
  assert.equal(attempts, 2)
  assert.equal(h.feed.snapshot().terminal, false)
  await h.advance(2000)
  assert.equal(attempts, 3)
  assert.equal(h.feed.snapshot().terminal, true)
  assert.deepEqual(h.feed.snapshot().execution, { status: 'failed', exit_code: 7 })
  assert.equal(h.feed.snapshot().points, points)
  assert.equal(h.feed.snapshot().points.progress.completed, 3)
  assert.deepEqual(h.feed.snapshot().points.progress.logs, ['last good'])
  assert.deepEqual(lossOf(h.feed), [2])
  assert.equal(h.timers.length, 0)
  await h.advance(30_000)
  assert.equal(attempts, 3)
  assert.equal(h.requests.length, before + 3)
  h.feed.dispose()
})
