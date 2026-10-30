/** Minimal PDF cross-reference/trailer validation, not a renderer. Only xref and root object streams are decoded.
 * Lexing skips comments, literal/hex strings and stream bodies; /Encrypt in prose is never an encryption key. */
import { inflateSync } from 'node:zlib'
const LIMIT = 20 * 1024 * 1024
const fail = (why: string): never => { throw new Error(`PDF: ${why}`) }
type Value = number | string | { name: string } | { ref: number; generation: number } | Value[] | Map<string, Value>
const number = (v: Value | undefined): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail('expected a nonnegative integer')
const dict = (v: Value): Map<string, Value> => v instanceof Map ? v : fail('expected a dictionary')
const named = (v: Value | undefined, name: string) => !!v && typeof v === 'object' && 'name' in v && v.name === name
const reference = (v: Value | undefined): { ref: number; generation: number } => v && typeof v === 'object' && 'ref' in v ? v : fail('missing indirect root reference')
class Parser {
  count = 0
  constructor(readonly source: string, public at: number) {}
  white() { while (this.at < this.source.length) { if (/[\0\t\n\f\r ]/.test(this.source[this.at]!)) this.at++; else if (this.source[this.at] === '%') { while (this.at < this.source.length && !/[\r\n]/.test(this.source[this.at]!)) this.at++ } else break } }
  word(): string { this.white(); const m = /^[^\s\0()[\]<>/%]+/.exec(this.source.slice(this.at)); if (!m) return fail('expected a token'); this.at += m[0].length; return m[0] }
  value(depth = 0): Value {
    if (depth > 32 || ++this.count > 100_000) return fail('dictionary complexity exceeds application bound')
    this.white()
    const s = this.source, c = s[this.at]
    if (s.startsWith('<<', this.at)) {
      this.at += 2; const out = new Map<string, Value>()
      for (;;) {
        this.white(); if (s.startsWith('>>', this.at)) { this.at += 2; return out }
        const key = this.value(depth + 1)
        if (!key || typeof key !== 'object' || !('name' in key)) return fail('dictionary key is not a name')
        if (out.has(key.name)) return fail('duplicate dictionary key')
        out.set(key.name, this.value(depth + 1))
      }
    }
    if (c === '/') { this.at++; const m = /^[^\s\0()[\]<>/%]*/.exec(s.slice(this.at))![0]; this.at += m.length; return { name: m.replace(/#([a-f\d]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))) } }
    if (c === '(') {
      this.at++; let nesting = 1
      while (this.at < s.length && nesting) { const ch = s[this.at++]!; if (ch === '\\') { if (s[this.at] === '\r' && s[this.at + 1] === '\n') this.at++; this.at++ } else if (ch === '(') nesting++; else if (ch === ')') nesting-- }
      if (nesting) return fail('unterminated literal string'); return 'string'
    }
    if (c === '<') { const end = s.indexOf('>', ++this.at); if (end < 0 || !/^[\da-f\s]*$/i.test(s.slice(this.at, end))) return fail('invalid hex string'); this.at = end + 1; return 'string' }
    if (c === '[') { this.at++; const out: Value[] = []; for (;;) { this.white(); if (s[this.at] === ']') { this.at++; return out } out.push(this.value(depth + 1)) } }
    const token = this.word()
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      const n = Number(token), end = this.at
      // Indirect references use the same token whitespace/comments as every other PDF value.
      if (/^\d+$/.test(token)) {
        try {
          const generation = this.word()
          if (/^\d+$/.test(generation) && this.word() === 'R') return { ref: n, generation: Number(generation) }
        } catch { /* a scalar before a delimiter: restore the lookahead */ }
      }
      this.at = end
      return n
    }
    if (['null', 'true', 'false'].includes(token)) return token
    return fail('invalid dictionary value')
  }
}
/** PNG predictors in Flate streams: bounded row geometry, every row has a PNG filter byte (0..4). */
function undoPredictor(raw: Buffer, params: Map<string, Value>): Buffer {
  const predictor = number(params.get('Predictor') ?? 1)
  if (predictor === 1) return raw
  if (predictor < 10 || predictor > 15) return fail('unsupported cross-reference stream predictor')
  const columns = number(params.get('Columns') ?? 1), colors = number(params.get('Colors') ?? 1), bits = number(params.get('BitsPerComponent') ?? 8)
  const rowBytes = Math.ceil(columns * colors * bits / 8), bpp = Math.ceil(colors * bits / 8)
  if (!columns || !colors || ![1, 2, 4, 8, 16].includes(bits) || !Number.isSafeInteger(rowBytes) || rowBytes < 1 || rowBytes > LIMIT || !raw.length || raw.length % (rowBytes + 1)) return fail('invalid/truncated predictor rows or Columns')
  const rows = raw.length / (rowBytes + 1)
  if (rows * rowBytes > LIMIT) return fail('predictor output exceeds application bound')
  const out = Buffer.alloc(rows * rowBytes)
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c)
    return x <= y && x <= z ? a : y <= z ? b : c
  }
  for (let row = 0; row < rows; row++) {
    const input = row * (rowBytes + 1), target = row * rowBytes, filter = raw[input]!
    if (filter > 4) return fail('invalid PNG predictor row filter')
    for (let col = 0; col < rowBytes; col++) {
      const left = col >= bpp ? out[target + col - bpp]! : 0, up = row ? out[target + col - rowBytes]! : 0
      const corner = row && col >= bpp ? out[target + col - rowBytes - bpp]! : 0
      const correction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, corner)
      out[target + col] = (raw[input + 1 + col]! + correction) & 255
    }
  }
  return out
}

type Entry = { type: number; a: number; b: number }
export function validatePdf(bytes: Uint8Array): void {
  const s = Buffer.from(bytes).toString('latin1')
  if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(s)) fail('unsupported header')
  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)
  if (!tail) fail('missing startxref/EOF')
  const entries = new Map<number, Entry>(), visited = new Set<number>()
  let root: ReturnType<typeof reference> | undefined
  function object(at: number, id?: number, generation?: number) {
    const parser = new Parser(s, at)
    const n = Number(parser.word()), gen = Number(parser.word())
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(gen) || parser.word() !== 'obj' || id !== undefined && (n !== id || gen !== generation)) fail('xref does not point to its object')
    const d = dict(parser.value()); parser.white()
    return { parser, d }
  }
  function stream(parser: Parser, d: Map<string, Value>): Buffer {
    if (parser.word() !== 'stream') fail('xref/object stream has no stream')
    if (s[parser.at] === '\r') parser.at++
    if (s[parser.at] === '\n') parser.at++; else fail('stream requires EOL')
    const length = number(d.get('Length')), stop = parser.at + length
    if (length === 0 || stop > bytes.length) fail('truncated or empty stream')
    const raw = Buffer.from(bytes.subarray(parser.at, stop)); parser.at = stop
    if (parser.word() !== 'endstream' || parser.word() !== 'endobj') fail('truncated stream/object')
    const filter = d.get('Filter')
    if (!filter) return raw
    if (!named(filter, 'FlateDecode') && !(Array.isArray(filter) && filter.length === 1 && named(filter[0], 'FlateDecode'))) return fail('unsupported cross-reference stream filter')
    let params = d.get('DecodeParms')
    if (Array.isArray(params)) {
      if (params.length !== 1) return fail('DecodeParms does not match the single supported filter')
      params = params[0]
    }
    if (params && params !== 'null' && !(params instanceof Map)) return fail('invalid DecodeParms')
    let decoded: Buffer
    try { decoded = inflateSync(raw, { maxOutputLength: LIMIT }) } catch { return fail('invalid or oversized compressed stream') }
    return undoPredictor(decoded, params instanceof Map ? params : new Map())
  }

  function section(at: number, sameRevision?: ReadonlySet<number>): void {
    // A hybrid supplement replaces THIS revision's table entries, but never an entry from a newer revision.
    const newer = sameRevision ?? new Set(entries.keys())
    const install = (id: number, entry: Entry) => { if (!newer.has(id)) entries.set(id, entry) }
    if (!Number.isSafeInteger(at) || at < 8 || at >= bytes.length || visited.has(at) || visited.size >= 32) fail('invalid/cyclic xref offset')
    visited.add(at)
    let d: Map<string, Value>
    const table = /^xref\b/.test(s.slice(at))
    if (sameRevision && table) fail('XRefStm must point to a cross-reference stream')
    if (table) {
      const parser = new Parser(s, at + 4)
      const fresh: [number, Entry][] = []
      for (;;) {
        parser.white(); if (s.startsWith('trailer', parser.at)) { parser.at += 7; break }
        const start = Number(parser.word()), count = Number(parser.word())
        if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1 || start + count > 1_000_000) fail('invalid xref subsection')
        for (let i = 0; i < count; i++) {
          const a = Number(parser.word()), b = Number(parser.word()), state = parser.word()
          if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0 || b > 65535 || !['n', 'f'].includes(state)) fail('invalid xref entry')
          if (state === 'n' && !s.slice(a).startsWith(`${start + i} ${b} obj`)) {
            const check = new Parser(s, a)
            if (check.word() !== String(start + i) || check.word() !== String(b) || check.word() !== 'obj') fail('xref points outside its object')
          }
          fresh.push([start + i, { type: state === 'n' ? 1 : 0, a, b }])
        }
      }
      d = dict(parser.value())
      const size = number(d.get('Size'))
      for (const [n, e] of fresh) { if (n >= size) fail('xref exceeds trailer Size'); install(n, e) }
    } else {
      const obj = object(at); d = obj.d
      if (!named(d.get('Type'), 'XRef')) fail('startxref must point to xref or a /Type /XRef stream')
      const widths = d.get('W'), size = number(d.get('Size'))
      if (!Array.isArray(widths) || widths.length !== 3 || widths.some((w) => typeof w !== 'number' || !Number.isInteger(w) || w < 0 || w > 8)) fail('invalid xref stream W')
      const w = widths as number[], stride = w.reduce((a, b) => a + b, 0), index = d.get('Index') ?? [0, size]
      if (!stride || !Array.isArray(index) || index.length % 2) fail('invalid xref stream Index')
      const raw = stream(obj.parser, d); let p = 0
      const read = (width: number, fallback = 0) => { if (!width) return fallback; if (p + width > raw.length) return fail('truncated xref stream'); let n = 0; for (let i = 0; i < width; i++) n = n * 256 + raw[p++]!; if (!Number.isSafeInteger(n)) fail('xref offset too large'); return n }
      const ranges = index as Value[]
      for (let i = 0; i < ranges.length; i += 2) {
        const start = number(ranges[i]), count = number(ranges[i + 1]); if (start + count > size || count > 1_000_000) fail('invalid xref range')
        for (let j = 0; j < count; j++) { const e = { type: read(w[0]!, 1), a: read(w[1]!), b: read(w[2]!) }; if (![0, 1, 2].includes(e.type)) fail('invalid xref entry type'); install(start + j, e) }
      }
      if (p !== raw.length) fail('xref stream length does not match entries')
    }
    if (d.has('Encrypt') && d.get('Encrypt') !== 'null') fail('encrypted/password-protected PDF is not supported')
    if (!root && d.has('Root')) root = reference(d.get('Root'))
    if (table && d.has('XRefStm')) section(number(d.get('XRefStm')), newer)
    // Like qpdf, ignore a supplemental stream's Prev; follow the owning table's Prev afterwards.
    if (!sameRevision && d.has('Prev')) section(number(d.get('Prev')))
  }
  section(Number(tail![1]))
  if (!root) fail('no trailer root')
  const r = root!, e = entries.get(r.ref)
  let catalog: Map<string, Value>
  if (e?.type === 1) {
    const obj = object(e.a, r.ref, r.generation); catalog = obj.d
    if (obj.parser.word() !== 'endobj') fail('root is not a dictionary object')
  } else if (e?.type === 2 && r.generation === 0) {
    const container = entries.get(e.a)
    if (container?.type !== 1) fail('missing root object stream')
    const obj = object(container!.a, e.a, container!.b)
    if (!named(obj.d.get('Type'), 'ObjStm')) fail('root is not in an object stream')
    const count = number(obj.d.get('N')), first = number(obj.d.get('First')), raw = stream(obj.parser, obj.d).toString('latin1')
    if (count > 100_000 || e.b >= count || first >= raw.length) fail('invalid object stream header')
    const header = new Parser(raw, 0); let offset = -1
    for (let i = 0; i < count; i++) { const id = Number(header.word()), at = Number(header.word()); if (i === e.b && id === r.ref) offset = at }
    if (header.at > first || offset < 0 || first + offset >= raw.length) fail('invalid compressed root offset')
    catalog = dict(new Parser(raw, first + offset).value())
  } else return fail('root is absent from xref')
  if (!named(catalog.get('Type'), 'Catalog')) fail('root is not a Catalog')
  reference(catalog.get('Pages'))
}
