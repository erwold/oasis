/** An image is sent to Anthropic fitted to 2576 px on its long side (image_fit.ts): a history with more than 20 images
 *  is refused by the API when any image is over its many-image limit (3000 px), and the model sees at most 2576 px
 *  anyway. The record keeps the image as it was; an image that fits, another provider's request, and an image that
 *  cannot be fitted go as they were. Real `sips` on macOS; the rest of the run is skipped elsewhere. */

import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_REQUEST_LIMITS, type ImagePiece } from '@oasis-code/contract'
import { hydrateAttachments } from '../src/llm/attachments.ts'
import { fitImage, forgetFittedImages, IMAGE_SEND_MAX_SIDE, jpegImage, planRequestImages, REQUEST_IMAGE_SHARE, setFittedImageDir } from '../src/llm/image_fit.ts'
import { measureImage } from '../src/llm/images.ts'
import { modelRequest, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { sha256Hex } from '../src/store.ts'
import { noisyPng, solidPng } from './png_fixture.ts'

const mac = process.platform === 'darwin'
afterEach(() => forgetFittedImages())

function jpegOf(png: Uint8Array): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'fit-jpeg-'))
  try {
    writeFileSync(join(dir, 'in.png'), png)
    spawnSync('/usr/bin/sips', ['-s', 'format', 'jpeg', join(dir, 'in.png'), '--out', join(dir, 'out.jpg')], { stdio: 'ignore' })
    return new Uint8Array(readFileSync(join(dir, 'out.jpg')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
function piece(bytes: Uint8Array, name: string): ImagePiece {
  const m = measureImage(bytes)
  return { kind: 'image', asset_id: `a_${name}`, media_type: m.media_type, bytes: bytes.length, sha256: sha256Hex(bytes), width: m.width, height: m.height, name }
}
const sent = (messages: ModelMessage[]) => ((messages[0] as { parts: { content: unknown[] }[] }).parts[0]!.content[1] as ImagePiece)

test('Anthropic takes 2576 px a side: the official high-resolution long edge, under the many-image limit', () => {
  expect(IMAGE_SEND_MAX_SIDE.anthropic).toBe(2576)
  expect(IMAGE_SEND_MAX_SIDE.openai_api).toBeUndefined()
})

test.skipIf(!mac)('a PNG over the side is fitted to it, keeps its aspect and format, and the same image gives the same bytes', () => {
  const png = solidPng(4000, 1000, [200, 100, 50])
  const a = fitImage(png, 'image/png', sha256Hex(png), 2576)!
  expect(a.media_type).toBe('image/png')
  expect([a.width, a.height]).toEqual([2576, 644])
  const b = fitImage(png, 'image/png', sha256Hex(png), 2576)!
  expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true)
})

test.skipIf(!mac)('a JPEG stays a JPEG; an image that fits is not touched', () => {
  const jpg = jpegOf(solidPng(1200, 3200, [10, 120, 230]))
  const fit = fitImage(jpg, 'image/jpeg', sha256Hex(jpg), 2576)!
  expect(fit.media_type).toBe('image/jpeg')
  expect(Math.max(fit.width, fit.height)).toBe(2576)
  const small = solidPng(2576, 1000, [0, 0, 0])
  expect(fitImage(small, 'image/png', sha256Hex(small), 2576)).toBeNull()
})

test('an image that cannot be fitted goes as it was, and says why in the log', () => {
  const png = solidPng(3200, 100, [1, 2, 3])
  const lines: string[] = []
  expect(fitImage(png, 'image/png', sha256Hex(png), 2576, { resize: () => false, log: (l) => lines.push(l) })).toBeNull()
  expect(lines.join('\n')).toContain('resizing to 2576 px failed')
  expect(fitImage(png, 'image/png', sha256Hex(png), 2576, { platform: 'linux', log: (l) => lines.push(l) })).toBeNull()
  expect(lines.join('\n')).toContain('needs macOS sips')
})

test.skipIf(!mac)('a request to Anthropic carries the fitted image; another provider and the record keep the original', () => {
  const png = solidPng(5000, 2500, [90, 90, 90])
  const p = piece(png, 'sheet.png')
  const history = [modelRequest([userPrompt(['look', p])])]
  const read = ((a: { sha256: string }) => (a.sha256 === p.sha256 ? png : null)) as unknown as Parameters<typeof hydrateAttachments>[1]
  const toAnthropic = sent(hydrateAttachments(history, read, { images: true }, 'claude', null, { limits: PROVIDER_REQUEST_LIMITS.anthropic }))
  const fitted = Buffer.from(toAnthropic.data!, 'base64')
  const m = measureImage(fitted)
  expect([m.width, m.height]).toEqual([2576, 1288])
  expect(toAnthropic.media_type).toBe('image/png')
  const toOpenAI = sent(hydrateAttachments(history, read, { images: true }, 'gpt', null, { limits: PROVIDER_REQUEST_LIMITS.openai_api }))
  expect(Buffer.from(toOpenAI.data!, 'base64').equals(Buffer.from(png))).toBe(true)
  // the history the run keeps is untouched: its piece has no bytes and its own size
  const kept = (history[0] as { parts: { content: unknown[] }[] }).parts[0]!.content[1] as ImagePiece
  expect(kept.data).toBeUndefined()
  expect([kept.width, kept.height]).toEqual([5000, 2500])
})

const shot = (n: number) => { const b = noisyPng(1344, 768, n + 1); return { sha256: sha256Hex(b), media_type: 'image/png' as const, bytes: b } }
const encoded = (n: number) => 4 * Math.ceil(n / 3)
const sentTotal = (images: { sha256: string; bytes: Uint8Array }[], plan: Map<string, { bytes: Uint8Array }>) => images.reduce((n, i) => n + encoded(plan.get(i.sha256)?.bytes.length ?? i.bytes.length), 0)

test.skipIf(!mac)('images that fit the request go as they were; over 32 MB the earliest PNGs go as JPEG until under 85% of it', () => {
  const few = Array.from({ length: 4 }, (_, n) => shot(n))
  expect(planRequestImages(few, PROVIDER_REQUEST_LIMITS.anthropic, 0).size).toBe(0)
  const many = Array.from({ length: 9 }, (_, n) => shot(n))
  expect(sentTotal(many, new Map())).toBeGreaterThanOrEqual(PROVIDER_REQUEST_LIMITS.anthropic.request_bytes)
  const plan = planRequestImages(many, PROVIDER_REQUEST_LIMITS.anthropic, 0)
  expect(sentTotal(many, plan)).toBeLessThan(PROVIDER_REQUEST_LIMITS.anthropic.request_bytes * REQUEST_IMAGE_SHARE)
  // the earliest ones, in order, and only as many as needed: the latest stay PNG
  const converted = many.map((i) => plan.get(i.sha256)?.media_type ?? 'image/png')
  const k = converted.indexOf('image/png')
  expect(k).toBeGreaterThan(0)
  expect(converted.slice(0, k).every((t) => t === 'image/jpeg')).toBe(true)
  expect(converted.slice(k).every((t) => t === 'image/png')).toBe(true)
  // a JPEG keeps the image's size
  const first = measureImage(plan.get(many[0]!.sha256)!.bytes)
  expect([first.width, first.height]).toEqual([1344, 768])
})

test.skipIf(!mac)('as the conversation grows, an image sent as JPEG stays one, with the same bytes', () => {
  const many = Array.from({ length: 9 }, (_, n) => shot(n))
  const before = planRequestImages(many, PROVIDER_REQUEST_LIMITS.anthropic, 0)
  const after = planRequestImages([...many, shot(9), shot(10)], PROVIDER_REQUEST_LIMITS.anthropic, 0)
  for (const [sha, jpeg] of before) expect(Buffer.from(after.get(sha)!.bytes).equals(Buffer.from(jpeg.bytes))).toBe(true)
  expect(after.size).toBeGreaterThanOrEqual(before.size)
})

test.skipIf(!mac)('a history of JPEGs over 32 MB: the earliest go again as JPEG fitted to 1288 px, one by one, until under 85% of it; the latest as they were; and so they stay as it grows', () => {
  const jpegShot = (n: number) => { const b = jpegOf(noisyPng(2576, 1449, n + 1)); return { sha256: sha256Hex(b), media_type: 'image/jpeg' as const, bytes: b } }
  const one = jpegShot(0).bytes.length
  const count = Math.ceil(PROVIDER_REQUEST_LIMITS.anthropic.request_bytes / encoded(one)) + 1
  const many = Array.from({ length: count }, (_, n) => jpegShot(n))
  expect(sentTotal(many, new Map())).toBeGreaterThanOrEqual(PROVIDER_REQUEST_LIMITS.anthropic.request_bytes)
  const plan = planRequestImages(many, PROVIDER_REQUEST_LIMITS.anthropic, 0)
  expect(sentTotal(many, plan)).toBeLessThan(PROVIDER_REQUEST_LIMITS.anthropic.request_bytes * REQUEST_IMAGE_SHARE)
  const sides = many.map((i) => { const p = plan.get(i.sha256); return p ? Math.max(p.width, p.height) : 2576 })
  const k = sides.indexOf(2576)
  expect(k).toBeGreaterThan(0)
  expect(sides.slice(0, k).every((x) => x === 1288)).toBe(true)
  expect(sides.slice(k).every((x) => x === 2576)).toBe(true)
  const after = planRequestImages([...many, jpegShot(count)], PROVIDER_REQUEST_LIMITS.anthropic, 0)
  for (const [sha, small] of plan) expect(Buffer.from(after.get(sha)!.bytes).equals(Buffer.from(small.bytes))).toBe(true)
}, 120_000)

test('another provider never re-encodes: its images go as recorded', () => {
  const many = Array.from({ length: 9 }, (_, n) => shot(n))
  expect(planRequestImages(many, PROVIDER_REQUEST_LIMITS.openai_api, 0).size).toBe(0)
})

test.skipIf(!mac)('a history over 32 MB of PNG frames goes to Anthropic, under the bound; the record keeps every PNG', () => {
  const frames = Array.from({ length: 9 }, (_, n) => noisyPng(1344, 768, n + 1))
  const pieces = frames.map((b, n) => piece(b, `f${n}.png`))
  const history = [modelRequest([userPrompt(['frames', ...pieces])])]
  const read = ((a: { sha256: string }) => frames.find((b) => sha256Hex(b) === a.sha256) ?? null) as unknown as Parameters<typeof hydrateAttachments>[1]
  // before this, the history was refused before anything was sent
  expect(pieces.reduce((n, p) => n + encoded(p.bytes), 0)).toBeGreaterThanOrEqual(PROVIDER_REQUEST_LIMITS.anthropic.request_bytes)
  const out = hydrateAttachments(history, read, { images: true }, 'claude', null, { limits: PROVIDER_REQUEST_LIMITS.anthropic })
  const sentPieces = (out[0] as { parts: { content: unknown[] }[] }).parts[0]!.content.slice(1) as ImagePiece[]
  const total = sentPieces.reduce((n, p) => n + p.data!.length, 0)
  expect(total).toBeLessThan(PROVIDER_REQUEST_LIMITS.anthropic.request_bytes)
  expect(sentPieces.some((p) => p.media_type === 'image/jpeg')).toBe(true)
  const kept = (history[0] as { parts: { content: unknown[] }[] }).parts[0]!.content.slice(1) as ImagePiece[]
  expect(kept.every((p) => p.media_type === 'image/png' && p.data === undefined)).toBe(true)
  // the same history to another provider is refused as before (its bound weighed from the records)
  expect(() => hydrateAttachments(history, read, { images: true }, 'gpt', null, { limits: { ...PROVIDER_REQUEST_LIMITS.openai_api, request_bytes: PROVIDER_REQUEST_LIMITS.anthropic.request_bytes } })).toThrow(/would weigh at least/)
})

test.skipIf(!mac)('a fitted image is made once: kept on disk, a later request (or a restart: memory cleared) reads it without converting again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fit-disk-'))
  setFittedImageDir(dir)
  try {
    const big = solidPng(3000, 1500, [10, 120, 200])
    const sha = sha256Hex(big)
    let conversions = 0
    const counting = (from: string, to: string, side: number | null, format: 'png' | 'jpeg', quality?: number) => {
      conversions += 1
      const r = spawnSync('/usr/bin/sips', ['-s', 'format', format, ...(format === 'jpeg' ? ['-s', 'formatOptions', String(quality ?? 92)] : []), ...(side !== null ? ['-Z', String(side)] : []), from, '--out', to], { stdio: 'ignore' })
      return r.status === 0
    }
    const first = fitImage(big, 'image/png', sha, 2576, { resize: counting })!
    const jpeg = jpegImage(big, sha, 2576, { resize: counting })!
    expect(conversions).toBe(2)
    forgetFittedImages()
    const again = fitImage(big, 'image/png', sha, 2576, { resize: counting })!
    const jpegAgain = jpegImage(big, sha, 2576, { resize: counting })!
    expect(conversions).toBe(2)
    expect(Buffer.from(again.bytes).equals(Buffer.from(first.bytes))).toBe(true)
    expect([again.media_type, again.width, again.height]).toEqual(['image/png', 2576, 1288])
    expect(Buffer.from(jpegAgain.bytes).equals(Buffer.from(jpeg.bytes))).toBe(true)
    expect(jpegAgain.media_type).toBe('image/jpeg')
  } finally {
    setFittedImageDir(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
