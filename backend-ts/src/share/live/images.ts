/** The live share's pictures: the session's own PNG / JPEG / WebP bytes with everything that is not the picture removed,
 *  before any byte reaches a viewer. This is STRUCTURAL METADATA STRIPPING with strict validation — not a re-encode of
 *  the pixels and not equivalent to one: the pixel data is the source's (what a screenshot shows is shared as shown),
 *  and data hidden INSIDE a compressed pixel payload (steganography, unusual encoder output in a VP8 / VP8L bitstream or
 *  a JPEG scan) is not promised to be removed. What is promised: every byte outside the pixel payload is either
 *  rebuilt by this module from the fields it parsed and checked (headers, tables, chunk framing) or dropped (EXIF, XMP,
 *  ICC profiles, text chunks, comments, thumbnails, application segments, unknown chunks, padding, anything after the
 *  image's end); any structure this module cannot validate exactly fails closed (the picture is left out).
 *
 *  - PNG: IHDR exactly once and first (13 bytes, a valid colour type / depth pair), PLTE / tRNS checked against the
 *    colour type (length, count, order), IDAT consecutive, IEND last and empty. The IDAT stream is inflated, must be
 *    exactly the size the header implies with valid filter bytes, and is deflated again into one IDAT; ancillary chunks
 *    are dropped, an unknown critical chunk refuses the picture. Every chunk written is framed and CRC'd here.
 *  - JPEG: baseline / extended / progressive Huffman only (SOF0–SOF2), 8-bit, 1 or 3 components; DQT, DHT, DRI parsed
 *    to their exact lengths; SOS headers checked; APPn and COM dropped; any other marker (arithmetic coding, DNL,
 *    hierarchical, CMYK) refuses it; nothing after EOI.
 *  - WebP: a simple file (VP8 / VP8L) or an extended still one (VP8X + optional ALPH + VP8 / VP8L) only; VP8X and ALPH
 *    reserved bits must be zero, RIFF padding must be zero, the canvas must match the image; VP8X is rebuilt (only its
 *    alpha flag kept); ICCP, EXIF, XMP and unknown chunks are dropped; an animation refuses it. */

import { deflateSync, inflateSync } from 'node:zlib'
import { measureImage } from '../../llm/images.ts'

export type StripMediaType = 'image/png' | 'image/jpeg' | 'image/webp'
export type StripResult = { ok: true; bytes: Uint8Array; media_type: StripMediaType; width: number; height: number } | { ok: false; reason: 'unsupported' | 'damaged' }

/** The policy's version: part of the cache key of a stripped picture (a change of rules strips again). */
export const STRIP_POLICY = 'strip-v2'
/** the most a stripped picture may weigh (a re-deflated PNG can be a little larger than its source) */
export const MAX_STRIPPED_BYTES = 8 * 1024 * 1024
/** the most pixel bytes a PNG may inflate to (16 MP at 16-bit RGBA, with its filter bytes) */
const MAX_INFLATED_BYTES = 16_777_216 * 8 + 16_777_216

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

class Refused extends Error { constructor(readonly reason: 'unsupported' | 'damaged') { super(reason) } }
const damaged = (): never => { throw new Refused('damaged') }
const unsupported = (): never => { throw new Refused('unsupported') }
const need = (ok: boolean): void => { if (!ok) damaged() }

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// ---- PNG ---------------------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Uint8Array, start = 0, end = b.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

/** colour type → [channels, allowed bit depths] */
const PNG_COLOR: Record<number, [number, number[]]> = { 0: [1, [1, 2, 4, 8, 16]], 2: [3, [8, 16]], 3: [1, [1, 2, 4, 8]], 4: [2, [8, 16]], 6: [4, [8, 16]] }
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const

/** The rows (bytes per row without the filter byte) the pixel data holds, pass by pass. */
function pngRows(width: number, height: number, bitsPerPixel: number, interlaced: boolean): { rows: number; rowBytes: number }[] {
  const rowBytes = (w: number) => Math.ceil((w * bitsPerPixel) / 8)
  if (!interlaced) return [{ rows: height, rowBytes: rowBytes(width) }]
  const out: { rows: number; rowBytes: number }[] = []
  for (const [x0, y0, dx, dy] of ADAM7) {
    const w = Math.ceil((width - x0) / dx)
    const h = Math.ceil((height - y0) / dy)
    if (w > 0 && h > 0) out.push({ rows: h, rowBytes: rowBytes(w) })
  }
  return out
}

function stripPng(b: Uint8Array): Uint8Array {
  need(b.length >= 8 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a)
  let i = 8
  let ihdr: Uint8Array | null = null
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0
  let plte: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  let idatClosed = false
  let ended = false
  while (!ended) {
    need(i + 12 <= b.length)
    const length = u32be(b, i)
    const type = ascii(b, i + 4, 4)
    need(/^[A-Za-z]{4}$/.test(type) && length <= 0x7fffffff && i + 12 + length <= b.length)
    need(crc32(b, i + 4, i + 8 + length) === u32be(b, i + 8 + length))
    const data = b.subarray(i + 8, i + 8 + length)
    i += 12 + length
    if (ihdr === null) need(type === 'IHDR')
    if (idat.length > 0 && type !== 'IDAT') idatClosed = true
    switch (type) {
      case 'IHDR': {
        need(ihdr === null && length === 13)
        width = u32be(data, 0); height = u32be(data, 4); depth = data[8]!; color = data[9]!; interlace = data[12]!
        const spec = PNG_COLOR[color]
        need(width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff && spec !== undefined && spec[1].includes(depth))
        need(data[10] === 0 && data[11] === 0 && (interlace === 0 || interlace === 1))
        ihdr = data
        break
      }
      case 'PLTE': {
        need(plte === null && trns === null && idat.length === 0 && length >= 3 && length % 3 === 0 && length <= 768)
        if (color === 0 || color === 4) damaged()
        if (color === 3) need(length / 3 <= 1 << depth)
        plte = data
        break
      }
      case 'tRNS': {
        need(trns === null && idat.length === 0)
        if (color === 0) need(length === 2)
        else if (color === 2) need(length === 6)
        else if (color === 3) need(plte !== null && length >= 1 && length <= plte!.length / 3)
        else damaged()
        trns = data
        break
      }
      case 'IDAT':
        need(!idatClosed)
        idat.push(data)
        break
      case 'IEND':
        need(length === 0 && idat.length > 0)
        ended = true
        break
      default:
        // an unknown or other critical chunk: the picture may need it; an ancillary one is metadata: dropped
        if (type.charCodeAt(0) < 0x61) unsupported()
        if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') unsupported()   // an animation
    }
  }
  // anything after IEND is dropped
  if (color === 3) need(plte !== null)
  const [channels] = PNG_COLOR[color]!
  const passes = pngRows(width, height, channels * depth, interlace === 1)
  let expected = 0
  for (const p of passes) expected += p.rows * (p.rowBytes + 1)
  if (expected > MAX_INFLATED_BYTES) unsupported()
  let raw: Uint8Array
  try { raw = inflateSync(concat(idat), { maxOutputLength: expected + 1 }) } catch { return damaged() }
  need(raw.length === expected)
  let at = 0
  for (const p of passes) for (let r = 0; r < p.rows; r++) { need(raw[at]! <= 4); at += p.rowBytes + 1 }
  const parts: Uint8Array[] = [b.subarray(0, 8), pngChunk('IHDR', ihdr!)]
  // a suggested palette of a truecolour image is not the picture: only a palette image keeps its PLTE
  if (plte !== null && color === 3) parts.push(pngChunk('PLTE', plte))
  if (trns !== null) parts.push(pngChunk('tRNS', trns))
  parts.push(pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', new Uint8Array(0)))
  return concat(parts)
}

// ---- JPEG --------------------------------------------------------------------------------------------------------------

const SOF_ALLOWED = new Set([0xc0, 0xc1, 0xc2])

function stripJpeg(b: Uint8Array): Uint8Array {
  need(b.length >= 4 && b[0] === 0xff && b[1] === 0xd8)
  const out: Uint8Array[] = [new Uint8Array([0xff, 0xd8])]
  let i = 2
  let frame = false
  let components = 0
  let scans = 0
  for (;;) {
    need(i + 2 <= b.length && b[i] === 0xff)
    let m = b[i + 1]!
    while (m === 0xff) { i++; need(i + 2 <= b.length); m = b[i + 1]! }          // fill bytes before a marker
    if (m === 0xd9) { need(scans > 0); out.push(new Uint8Array([0xff, 0xd9])); break }   // EOI: nothing after it
    need(i + 4 <= b.length)
    const length = u16be(b, i + 2)
    need(length >= 2 && i + 2 + length <= b.length)
    const seg = b.subarray(i + 4, i + 2 + length)                                 // the segment's body
    const whole = b.subarray(i, i + 2 + length)
    i += 2 + length
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) continue                         // APPn, COM: dropped
    if (m === 0xdb) {                                                             // DQT: tables to the exact length
      let k = 0
      while (k < seg.length) { const pq = seg[k]! >> 4; const tq = seg[k]! & 0x0f; need(pq <= 1 && tq <= 3); k += 1 + (pq ? 128 : 64) }
      need(k === seg.length && seg.length > 0)
      out.push(whole)
    } else if (m === 0xc4) {                                                      // DHT
      let k = 0
      while (k < seg.length) {
        need(k + 17 <= seg.length)
        const tc = seg[k]! >> 4; const th = seg[k]! & 0x0f
        need(tc <= 1 && th <= 3)
        let n = 0
        for (let c = 1; c <= 16; c++) n += seg[k + c]!
        need(n <= 256)
        k += 17 + n
      }
      need(k === seg.length && seg.length > 0)
      out.push(whole)
    } else if (m === 0xdd) {                                                      // DRI
      need(seg.length === 2)
      out.push(whole)
    } else if (SOF_ALLOWED.has(m)) {
      need(!frame && seg.length >= 6)
      const precision = seg[0]!; const height = u16be(seg, 1); const width = u16be(seg, 3); const nf = seg[5]!
      if (precision !== 8 || (nf !== 1 && nf !== 3)) unsupported()
      need(height > 0 && width > 0 && seg.length === 6 + 3 * nf)
      for (let c = 0; c < nf; c++) {
        const h = seg[7 + 3 * c]! >> 4; const v = seg[7 + 3 * c]! & 0x0f; const tq = seg[8 + 3 * c]!
        need(h >= 1 && h <= 4 && v >= 1 && v <= 4 && tq <= 3)
      }
      frame = true
      components = nf
      out.push(whole)
    } else if (m === 0xda) {                                                      // SOS, then its entropy-coded data
      need(frame && seg.length >= 1)
      const ns = seg[0]!
      need(ns >= 1 && ns <= components && seg.length === 4 + 2 * ns)
      for (let c = 0; c < ns; c++) { const td = seg[2 + 2 * c]! >> 4; const ta = seg[2 + 2 * c]! & 0x0f; need(td <= 3 && ta <= 3) }
      let j = i
      while (j < b.length) {
        if (b[j] !== 0xff) { j++; continue }
        need(j + 1 < b.length)
        const next = b[j + 1]!
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { j += 2; continue }
        break
      }
      need(j < b.length)
      out.push(whole, b.subarray(i, j))
      scans++
      i = j
    } else {
      unsupported()                                                               // arithmetic, DNL, hierarchical, …
    }
  }
  need(frame && scans > 0)
  return concat(out)
}

// ---- WebP --------------------------------------------------------------------------------------------------------------

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2
  const out = new Uint8Array(8 + data.length + pad)
  for (let k = 0; k < 4; k++) out[k] = fourcc.charCodeAt(k)
  new DataView(out.buffer).setUint32(4, data.length, true)
  out.set(data, 8)
  return out
}

/** A VP8 key frame's size, its header checked; a VP8L image's size, its header checked. */
function vp8Size(d: Uint8Array): [number, number] {
  need(d.length >= 10 && (d[0]! & 1) === 0 && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a)
  const firstPartition = (d[0]! | (d[1]! << 8) | (d[2]! << 16)) >>> 5
  need(10 + firstPartition <= d.length)
  const w = u16be(new Uint8Array([d[7]!, d[6]!]), 0) & 0x3fff
  const h = u16be(new Uint8Array([d[9]!, d[8]!]), 0) & 0x3fff
  need(w > 0 && h > 0)
  return [w, h]
}
function vp8lSize(d: Uint8Array): [number, number] {
  need(d.length >= 5 && d[0] === 0x2f)
  need((d[4]! >> 5) === 0)                                                         // version 0
  const w = 1 + (((d[2]! & 0x3f) << 8) | d[1]!)
  const h = 1 + (((d[4]! & 0x0f) << 10) | (d[3]! << 2) | ((d[2]! & 0xc0) >> 6))
  return [w, h]
}

function stripWebp(b: Uint8Array): Uint8Array {
  need(b.length >= 20 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP')
  const riffEnd = 8 + u32le(b, 4)
  need(riffEnd <= b.length && riffEnd >= 20 && riffEnd % 2 === 0)
  const chunks: { fourcc: string; data: Uint8Array }[] = []
  let i = 12
  while (i < riffEnd) {
    need(i + 8 <= riffEnd)
    const fourcc = ascii(b, i, 4)
    const size = u32le(b, i + 4)
    need(i + 8 + size + (size % 2) <= riffEnd)
    if (size % 2) need(b[i + 8 + size] === 0)                                     // padding must be zero
    chunks.push({ fourcc, data: b.subarray(i + 8, i + 8 + size) })
    i += 8 + size + (size % 2)
  }
  const first = chunks[0]
  need(first !== undefined)
  if (chunks.some((c) => c.fourcc === 'ANIM' || c.fourcc === 'ANMF')) unsupported()
  const images = chunks.filter((c) => c.fourcc === 'VP8 ' || c.fourcc === 'VP8L')
  need(images.length === 1)
  const image = images[0]!
  const [w, h] = image.fourcc === 'VP8 ' ? vp8Size(image.data) : vp8lSize(image.data)
  const kept: Uint8Array[] = []
  if (first!.fourcc === 'VP8 ' || first!.fourcc === 'VP8L') {
    need(chunks.length === 1)                                                       // a simple file is one chunk
    kept.push(riffChunk(image.fourcc, image.data))
  } else if (first!.fourcc === 'VP8X') {
    const x = first!.data
    need(x.length === 10)
    const flags = x[0]!
    need((flags & 0xc1) === 0 && x[1] === 0 && x[2] === 0 && x[3] === 0)          // reserved bits and bytes are zero
    if (flags & 0x02) unsupported()
    const cw = 1 + u24le(x, 4)
    const ch = 1 + u24le(x, 7)
    need(cw === w && ch === h)
    const at = chunks.indexOf(image)
    const alphs = chunks.filter((c) => c.fourcc === 'ALPH')
    need(alphs.length <= 1)
    const alph = alphs[0] ?? null
    if (alph !== null) {
      need(image.fourcc === 'VP8 ' && chunks.indexOf(alph) === at - 1 && alph.data.length >= 1)
      need((alph.data[0]! >> 6) === 0 && (alph.data[0]! & 0x03) <= 1 && ((alph.data[0]! >> 2) & 0x03) <= 1)   // reserved, method, filtering
    }
    const alpha = alph !== null || (image.fourcc === 'VP8L' && (flags & 0x10) !== 0)
    const vp8x = new Uint8Array(10)
    vp8x[0] = alpha ? 0x10 : 0
    vp8x.set(x.subarray(4, 10), 4)
    kept.push(riffChunk('VP8X', vp8x))
    if (alph !== null) kept.push(riffChunk('ALPH', alph.data))
    kept.push(riffChunk(image.fourcc, image.data))
    // ICCP, EXIF, XMP and anything unknown: dropped
  } else unsupported()
  const body = concat(kept)
  const head = new Uint8Array(12)
  head.set([0x52, 0x49, 0x46, 0x46], 0)
  new DataView(head.buffer).setUint32(4, 4 + body.length, true)
  head.set([0x57, 0x45, 0x42, 0x50], 8)
  return concat([head, body])
}

/** The picture without its metadata, measured again; or why it is left out. `expect` is what the asset record says. */
export function stripImage(bytes: Uint8Array, expect: { media_type: string; width: number; height: number }): StripResult {
  try {
    let out: Uint8Array
    if (expect.media_type === 'image/png') out = stripPng(bytes)
    else if (expect.media_type === 'image/jpeg') out = stripJpeg(bytes)
    else if (expect.media_type === 'image/webp') out = stripWebp(bytes)
    else return { ok: false, reason: 'unsupported' }
    if (out.length > MAX_STRIPPED_BYTES) return { ok: false, reason: 'unsupported' }
    let measured
    try { measured = measureImage(out) } catch { return { ok: false, reason: 'damaged' } }
    if (measured.media_type !== expect.media_type || measured.width !== expect.width || measured.height !== expect.height) return { ok: false, reason: 'damaged' }
    return { ok: true, bytes: out, media_type: measured.media_type, width: measured.width, height: measured.height }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason }
    return { ok: false, reason: 'damaged' }
  }
}
