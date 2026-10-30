/** The live share's picture stripping (src/share/live/images.ts): strict structural validation, metadata out, every
 *  ambiguous structure refused. Synthetic bytes only; each carries a MARKER where metadata or hidden bytes could sit,
 *  and no accepted output may hold it. */

import { expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { stripImage } from '../src/share/live/images.ts'
import { solidPng } from './png_fixture.ts'

const MARKER = 'SYNTH-MARKER-' + '7'.repeat(6)
const enc = new TextEncoder()
const holdsMarker = (b: Uint8Array) => Buffer.from(b).toString('latin1').includes(MARKER)

function cat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  out.set(enc.encode(type), 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0)
  return out
}
const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function ihdr(w: number, h: number, depth = 8, color = 2): Uint8Array {
  const d = new Uint8Array(13)
  const v = new DataView(d.buffer)
  v.setUint32(0, w); v.setUint32(4, h)
  d.set([depth, color, 0, 0, 0], 8)
  return d
}
function rgbRows(w: number, h: number): Uint8Array {
  const row = new Uint8Array(1 + w * 3)
  const raw = new Uint8Array(row.length * h)
  for (let y = 0; y < h; y++) raw.set(row, y * row.length)
  return raw
}
const png = (...chunks: Uint8Array[]) => cat([SIG, ...chunks])
const EXPECT_PNG = { media_type: 'image/png', width: 4, height: 3 }

test('PNG: a plain picture passes; text, EXIF, time and trailing bytes are dropped', () => {
  const plain = stripImage(solidPng(4, 3, [1, 2, 3]), EXPECT_PNG)
  expect(plain.ok).toBe(true)
  const idat = chunk('IDAT', new Uint8Array(deflateSync(rgbRows(4, 3))))
  const dirty = png(chunk('IHDR', ihdr(4, 3)), chunk('tEXt', enc.encode(`Comment\0${MARKER}`)), chunk('eXIf', enc.encode(MARKER)), idat, chunk('tIME', new Uint8Array(7)),
    chunk('IEND', new Uint8Array()), enc.encode(MARKER))
  const out = stripImage(dirty, EXPECT_PNG)
  expect(out.ok).toBe(true)
  if (out.ok) { expect(holdsMarker(out.bytes)).toBe(false); expect(out.width).toBe(4) }
})

test('PNG: IEND with a payload, a second IHDR, an oversized or misplaced PLTE, a bad tRNS, split IDATs are refused', () => {
  const idat = chunk('IDAT', new Uint8Array(deflateSync(rgbRows(4, 3))))
  const cases: [string, Uint8Array][] = [
    ['IEND payload', png(chunk('IHDR', ihdr(4, 3)), idat, chunk('IEND', enc.encode(MARKER)))],
    ['second IHDR', png(chunk('IHDR', ihdr(4, 3)), chunk('IHDR', ihdr(4, 3)), idat, chunk('IEND', new Uint8Array()))],
    ['oversized PLTE', png(chunk('IHDR', ihdr(4, 3)), chunk('PLTE', new Uint8Array(771)), idat, chunk('IEND', new Uint8Array()))],
    ['PLTE not a multiple of 3', png(chunk('IHDR', ihdr(4, 3)), chunk('PLTE', new Uint8Array(10)), idat, chunk('IEND', new Uint8Array()))],
    ['PLTE on greyscale', png(chunk('IHDR', ihdr(4, 3, 8, 0)), chunk('PLTE', new Uint8Array(6)), idat, chunk('IEND', new Uint8Array()))],
    ['tRNS of the wrong length', png(chunk('IHDR', ihdr(4, 3)), chunk('tRNS', enc.encode(MARKER)), idat, chunk('IEND', new Uint8Array()))],
    ['IDAT split by another chunk', png(chunk('IHDR', ihdr(4, 3)), idat, chunk('tEXt', enc.encode('a\0b')), idat, chunk('IEND', new Uint8Array()))],
    ['no IHDR first', png(idat, chunk('IHDR', ihdr(4, 3)), chunk('IEND', new Uint8Array()))],
    ['bad CRC', (() => { const b = png(chunk('IHDR', ihdr(4, 3)), idat, chunk('IEND', new Uint8Array())); b[b.length - 13] ^= 1; return b })()],
    ['pixel data of the wrong size', png(chunk('IHDR', ihdr(4, 3)), chunk('IDAT', new Uint8Array(deflateSync(rgbRows(4, 2)))), chunk('IEND', new Uint8Array()))],
    ['bad filter byte', png(chunk('IHDR', ihdr(4, 3)), chunk('IDAT', new Uint8Array(deflateSync((() => { const r = rgbRows(4, 3); r[0] = 9; return r })()))), chunk('IEND', new Uint8Array()))],
    ['bad depth for colour type', png(chunk('IHDR', ihdr(4, 3, 4, 2)), idat, chunk('IEND', new Uint8Array()))],
  ]
  for (const [name, bytes] of cases) expect(stripImage(bytes, EXPECT_PNG).ok, name).toBe(false)
  // an animation is refused, an unknown critical chunk is refused
  expect(stripImage(png(chunk('IHDR', ihdr(4, 3)), chunk('acTL', new Uint8Array(8)), idat, chunk('IEND', new Uint8Array())), EXPECT_PNG)).toEqual({ ok: false, reason: 'unsupported' })
  expect(stripImage(png(chunk('IHDR', ihdr(4, 3)), chunk('ZZZZ', new Uint8Array(1)), idat, chunk('IEND', new Uint8Array())), EXPECT_PNG)).toEqual({ ok: false, reason: 'unsupported' })
})

test('PNG: bytes hidden after the zlib stream inside IDAT do not survive (the stream is inflated and deflated again)', () => {
  const z = new Uint8Array(deflateSync(rgbRows(4, 3)))
  const out = stripImage(png(chunk('IHDR', ihdr(4, 3)), chunk('IDAT', cat([z, enc.encode(MARKER)])), chunk('IEND', new Uint8Array())), EXPECT_PNG)
  if (out.ok) expect(holdsMarker(out.bytes)).toBe(false)
  // the declared size must be the record's
  expect(stripImage(solidPng(4, 3, [0, 0, 0]), { media_type: 'image/png', width: 5, height: 3 }).ok).toBe(false)
})

// ---- JPEG --------------------------------------------------------------------------------------------------------------

const seg = (marker: number, body: Uint8Array) => cat([new Uint8Array([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body])
const DQT = seg(0xdb, cat([new Uint8Array([0x00]), new Uint8Array(64).fill(1)]))
const SOF0 = (nf = 1, marker = 0xc0) => seg(marker, cat([new Uint8Array([8, 0, 2, 0, 3, nf]), ...Array.from({ length: nf }, (_, i) => new Uint8Array([i + 1, 0x11, 0]))]))
const DHT = seg(0xc4, cat([new Uint8Array([0x00, 1]), new Uint8Array(15), new Uint8Array([0])]))
const SOS = seg(0xda, new Uint8Array([1, 1, 0x00, 0, 63, 0]))
const SCAN = new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56])
const SOI = new Uint8Array([0xff, 0xd8])
const EOI = new Uint8Array([0xff, 0xd9])
const EXPECT_JPEG = { media_type: 'image/jpeg', width: 3, height: 2 }

test('JPEG: APPn (EXIF, XMP, ICC), COM and bytes after EOI are dropped; the frame passes', () => {
  const dirty = cat([SOI, seg(0xe1, enc.encode(`Exif\0\0${MARKER}`)), seg(0xe2, enc.encode(`ICC_PROFILE\0${MARKER}`)), seg(0xfe, enc.encode(MARKER)), DQT, SOF0(), DHT, SOS, SCAN, EOI, enc.encode(MARKER)])
  const out = stripImage(dirty, EXPECT_JPEG)
  expect(out.ok).toBe(true)
  if (out.ok) { expect(holdsMarker(out.bytes)).toBe(false); expect([out.width, out.height]).toEqual([3, 2]) }
})

test('JPEG: lossless / arithmetic / CMYK frames, malformed tables and scans are refused', () => {
  const cases: [string, Uint8Array, 'unsupported' | 'damaged'][] = [
    ['SOF3 lossless', cat([SOI, DQT, SOF0(1, 0xc3), DHT, SOS, SCAN, EOI]), 'unsupported'],
    ['DAC arithmetic', cat([SOI, DQT, seg(0xcc, new Uint8Array([0, 0x11])), SOF0(), DHT, SOS, SCAN, EOI]), 'unsupported'],
    ['CMYK', cat([SOI, DQT, SOF0(4), DHT, seg(0xda, new Uint8Array([1, 1, 0x00, 0, 63, 0])), SCAN, EOI]), 'unsupported'],
    ['DQT of the wrong length', cat([SOI, seg(0xdb, cat([new Uint8Array([0x00]), new Uint8Array(70)])), SOF0(), DHT, SOS, SCAN, EOI]), 'damaged'],
    ['DHT counts past its length', cat([SOI, DQT, SOF0(), seg(0xc4, cat([new Uint8Array([0x00, 5]), new Uint8Array(15)])), SOS, SCAN, EOI]), 'damaged'],
    ['SOS before a frame', cat([SOI, DQT, DHT, SOS, SCAN, EOI]), 'damaged'],
    ['no EOI', cat([SOI, DQT, SOF0(), DHT, SOS, SCAN]), 'damaged'],
    ['a second frame', cat([SOI, DQT, SOF0(), SOF0(), DHT, SOS, SCAN, EOI]), 'damaged'],
  ]
  for (const [name, bytes, reason] of cases) expect(stripImage(bytes, EXPECT_JPEG), name).toEqual({ ok: false, reason })
})

// ---- WebP --------------------------------------------------------------------------------------------------------------

function riff(chunks: Uint8Array[]): Uint8Array {
  const body = cat([enc.encode('WEBP'), ...chunks])
  const head = cat([enc.encode('RIFF'), new Uint8Array(4)])
  new DataView(head.buffer).setUint32(4, body.length, true)
  return cat([head, body])
}
function rchunk(fourcc: string, data: Uint8Array, pad = 0): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length % 2))
  out.set(enc.encode(fourcc), 0)
  new DataView(out.buffer).setUint32(4, data.length, true)
  out.set(data, 8)
  if (data.length % 2) out[8 + data.length] = pad
  return out
}
/** a VP8L header of 3 × 2 (14-bit width-1, 14-bit height-1, alpha 0, version 0) and some bitstream bytes */
const VP8L = new Uint8Array([0x2f, 0x02, 0x40, 0x00, 0x00, 1, 2, 3, 4, 5])
function vp8x(flags: number, reserved = 0): Uint8Array {
  const d = new Uint8Array(10)
  d[0] = flags; d[1] = reserved
  d.set([2, 0, 0], 4); d.set([1, 0, 0], 7)
  return d
}
const EXPECT_WEBP = { media_type: 'image/webp', width: 3, height: 2 }

test('WebP: a simple VP8L passes; an extended one keeps only VP8X (flags cleared) and the image, EXIF / XMP / ICCP dropped', () => {
  expect(stripImage(riff([rchunk('VP8L', VP8L)]), EXPECT_WEBP).ok).toBe(true)
  const dirty = riff([rchunk('VP8X', vp8x(0x20 | 0x08 | 0x04)), rchunk('ICCP', enc.encode(MARKER)), rchunk('VP8L', VP8L), rchunk('EXIF', enc.encode(MARKER)), rchunk('XMP ', enc.encode(MARKER))])
  const out = stripImage(cat([dirty, enc.encode(MARKER)]), EXPECT_WEBP)
  expect(out.ok).toBe(true)
  if (out.ok) { expect(holdsMarker(out.bytes)).toBe(false); expect(out.bytes[20]).toBe(0) }
})

test('WebP: reserved VP8X bits or bytes, non-zero padding, animation, a canvas that is not the image are refused', () => {
  const cases: [string, Uint8Array, 'unsupported' | 'damaged'][] = [
    ['VP8X reserved byte', riff([rchunk('VP8X', vp8x(0, 0x55)), rchunk('VP8L', VP8L)]), 'damaged'],
    ['VP8X reserved bit', riff([rchunk('VP8X', vp8x(0x80)), rchunk('VP8L', VP8L)]), 'damaged'],
    ['non-zero padding', riff([rchunk('VP8X', vp8x(0)), rchunk('EXIF', enc.encode('odd')), rchunk('VP8L', VP8L)].map((c, i) => i === 1 ? rchunk('EXIF', enc.encode('odd'), 0x4d) : c)), 'damaged'],
    ['animation', riff([rchunk('VP8X', vp8x(0x02)), rchunk('ANIM', new Uint8Array(6))]), 'unsupported'],
    ['canvas other than the image', riff([rchunk('VP8X', (() => { const d = vp8x(0); d.set([9, 0, 0], 4); return d })()), rchunk('VP8L', VP8L)]), 'damaged'],
    ['two images', riff([rchunk('VP8X', vp8x(0)), rchunk('VP8L', VP8L), rchunk('VP8L', VP8L)]), 'damaged'],
    ['simple file with a second chunk', riff([rchunk('VP8L', VP8L), rchunk('EXIF', enc.encode(MARKER))]), 'damaged'],
  ]
  for (const [name, bytes, reason] of cases) expect(stripImage(bytes, EXPECT_WEBP), name).toEqual({ ok: false, reason })
})
