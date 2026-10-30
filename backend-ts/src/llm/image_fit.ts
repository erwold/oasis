/** An image made to fit the long side a provider takes, at the moment a request carries it: the record keeps the
 *  image as it was attached or read, only the bytes sent are fitted. For Anthropic the side is 2576 px — the
 *  long-edge limit of its high-resolution tier (Claude 4.7 and later: an image over it is downscaled by the API
 *  before the model sees it, so nothing the model would see is lost), and under the per-image limit the API applies
 *  to a request of more than 20 images ("many-image requests", 3000 px when this was written; 8000 px for fewer).
 *  Every image over the side is fitted, not only in a request of more than 20: the same image goes out as the same
 *  bytes on every request of a conversation, so crossing 20 images never rewrites the history already sent.
 *  Source: https://platform.claude.com/docs/en/build-with-claude/vision (Request limits; Resolution and token cost).
 *
 *  The resizing is the system's own (`sips`, macOS), as heif.ts converts HEIC; the fitted bytes are kept by the
 *  image's hash and side, so a conversation's every request sends one and the same picture. Where it cannot be
 *  fitted (no sips, a failure) the image goes as it was: what the request carried before this. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequestLimits } from '@oasis-code/contract'
import { measureImage, type ImageMediaType } from './images.ts'

/** The long side, per provider bounds, an image is fitted to before it is sent (none: sent as it is). */
export const IMAGE_SEND_MAX_SIDE: Partial<Record<RequestLimits['key'], number>> = { anthropic: 2576 }

/** The long side an image a connector's model is shown (the director's read_file) is fitted to: OpenAI's vision
 *  scales an image to fit 2048 × 2048 before it is seen at high detail, so nothing seen is lost.
 *  Source: https://platform.openai.com/docs/guides/images-vision (Calculating costs). */
export const CONNECTOR_IMAGE_SIDE = 2048

export interface FittedImage { bytes: Uint8Array; media_type: ImageMediaType; width: number; height: number }
/** One conversion: the image at `from` written at `to` as `format`, its long side `side` (null: its own size), a JPEG
 *  at `quality` (false: it did not work). */
export type ImageResizer = (from: string, to: string, side: number | null, format: 'png' | 'jpeg', quality?: number) => boolean

const SIPS = '/usr/bin/sips'
const RESIZE_TIMEOUT_MS = 30_000
const sips: ImageResizer = (from, to, side, format, quality = 92) => {
  const out = spawnSync(SIPS, ['-s', 'format', format, ...(format === 'jpeg' ? ['-s', 'formatOptions', String(quality)] : []), ...(side !== null ? ['-Z', String(side)] : []), from, '--out', to], { stdio: 'ignore', timeout: RESIZE_TIMEOUT_MS })
  return out.status === 0
}

// The fitted bytes, by image hash and variant: the most recently used in memory, every one on disk once a folder is
// set (setFittedImageDir: the data directory's). A conversion runs `sips` synchronously, which holds the whole backend
// while it runs; a conversation's images are asked for again on every request, by every run at work, so a variant is
// made once and read after — across requests, runs and restarts.
const KEPT = 160
const fitted = new Map<string, FittedImage>()
let diskDir: string | null = null

/** The folder fitted images are kept in across requests and restarts (null: memory only, as tests run). */
export function setFittedImageDir(dir: string | null): void { diskDir = dir }

const fileOf = (key: string) => (diskDir ? join(diskDir, key.replace(/[^A-Za-z0-9_-]/g, '_')) : null)

const keep = (key: string, value: FittedImage) => {
  fitted.delete(key)
  if (fitted.size >= KEPT) fitted.delete(fitted.keys().next().value!)
  fitted.set(key, value)
  const file = fileOf(key)
  if (file === null || existsSync(file)) return
  try {
    mkdirSync(diskDir!, { recursive: true })
    const part = `${file}.${process.pid}.part`
    writeFileSync(part, value.bytes)
    renameSync(part, file)
  } catch { /* memory still holds it */ }
}

/** A variant made before: in memory (kept as the most recent), else on disk; null when it was never made here. */
const made = (key: string): FittedImage | null => {
  const held = fitted.get(key)
  if (held) { fitted.delete(key); fitted.set(key, held); return held }
  const file = fileOf(key)
  if (file === null || !existsSync(file)) return null
  try {
    const bytes = new Uint8Array(readFileSync(file))
    const m = measureImage(bytes)
    const value: FittedImage = { bytes, media_type: m.media_type, width: m.width, height: m.height }
    keep(key, value)
    return value
  } catch { return null }
}

/** The image fitted to `side` on its long edge, or null when it already fits or cannot be fitted here. A PNG stays
 *  a PNG and a JPEG a JPEG; a WebP is written as a PNG (sips does not write WebP). */
export function fitImage(bytes: Uint8Array, media_type: ImageMediaType, sha256: string, side: number,
  { platform = process.platform, resize = sips, log = (line: string) => console.warn(line) }: { platform?: string; resize?: ImageResizer; log?: (line: string) => void } = {}): FittedImage | null {
  let size: { width: number; height: number }
  try { size = measureImage(bytes) } catch { return null }
  if (Math.max(size.width, size.height) <= side) return null
  const key = `${sha256}:${side}`
  const kept = made(key)
  if (kept) return kept
  if (platform !== 'darwin' && resize === sips) { log(`[images] ${size.width}×${size.height} image sent as it is: resizing to ${side} px needs macOS sips`); return null }
  const format: 'png' | 'jpeg' = media_type === 'image/jpeg' ? 'jpeg' : 'png'
  const dir = mkdtempSync(join(tmpdir(), 'oasis-fit-'))
  try {
    const from = join(dir, 'in'), to = join(dir, `out.${format === 'jpeg' ? 'jpg' : 'png'}`)
    writeFileSync(from, bytes)
    if (!resize(from, to, side, format)) { log(`[images] ${size.width}×${size.height} image sent as it is: resizing to ${side} px failed`); return null }
    const out = new Uint8Array(readFileSync(to))
    const measured = measureImage(out)
    if (Math.max(measured.width, measured.height) > side) { log(`[images] resizing to ${side} px gave ${measured.width}×${measured.height}; sent as it was`); return null }
    const result: FittedImage = { bytes: out, media_type: measured.media_type, width: measured.width, height: measured.height }
    keep(key, result)
    return result
  } catch (error) {
    log(`[images] ${size.width}×${size.height} image sent as it is: ${(error as Error).message}`)
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The quality a PNG or WebP is re-encoded at when a request's images would not fit it otherwise. */
export const REQUEST_JPEG_QUALITY = 95

/** The image as a JPEG at REQUEST_JPEG_QUALITY, fitted to `side` too when it is over it; null when it cannot be made
 *  here. Kept by hash, side and quality: the same image becomes the same bytes on every request. */
export function jpegImage(bytes: Uint8Array, sha256: string, side: number,
  { platform = process.platform, resize = sips, log = (line: string) => console.warn(line) }: { platform?: string; resize?: ImageResizer; log?: (line: string) => void } = {}): FittedImage | null {
  let size: { width: number; height: number }
  try { size = measureImage(bytes) } catch { return null }
  const key = `${sha256}:${side}:jpeg${REQUEST_JPEG_QUALITY}`
  const kept = made(key)
  if (kept) return kept
  if (platform !== 'darwin' && resize === sips) { log(`[images] ${size.width}×${size.height} image kept as it is: re-encoding needs macOS sips`); return null }
  const dir = mkdtempSync(join(tmpdir(), 'oasis-fit-'))
  try {
    const from = join(dir, 'in'), to = join(dir, 'out.jpg')
    writeFileSync(from, bytes)
    if (!resize(from, to, Math.max(size.width, size.height) > side ? side : null, 'jpeg', REQUEST_JPEG_QUALITY)) { log(`[images] ${size.width}×${size.height} image kept as it is: re-encoding as JPEG failed`); return null }
    const out = new Uint8Array(readFileSync(to))
    const m = measureImage(out)
    if (m.media_type !== 'image/jpeg' || Math.max(m.width, m.height) > side) return null
    const result: FittedImage = { bytes: out, media_type: 'image/jpeg', width: m.width, height: m.height }
    keep(key, result)
    return result
  } catch (error) {
    log(`[images] ${size.width}×${size.height} image kept as it is: ${(error as Error).message}`)
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The share of a provider's request bound a request's images and words are kept under: the rest is its tools, system
 *  prompt and settings. */
export const REQUEST_IMAGE_SHARE = 0.85

/** The long sides the earliest images are brought down to, in turn, when the request still weighs its bound once every
 *  PNG / WebP goes as JPEG (a history of JPEG screenshots): half the side, then a quarter. */
export const REQUEST_STEP_SIDES = [1288, 644] as const

/** One image of a request, in history order (the earliest first), with its bytes as recorded. */
export interface RequestImage { sha256: string; media_type: ImageMediaType; bytes: Uint8Array }

/** What each image of one request is sent as, by hash (absent: as it was recorded). Every image over the provider's
 *  side is fitted to it; then, only when the request's images and `otherEncoded` would weigh REQUEST_IMAGE_SHARE of the
 *  bound or more, the earliest PNG / WebP images are sent as JPEG at REQUEST_JPEG_QUALITY one by one until under it,
 *  and when that is not enough, the earliest images again as JPEG fitted to each of REQUEST_STEP_SIDES in turn (one by
 *  one, to the same share): an image once sent so stays so as the conversation grows (its turn is never rewritten
 *  back), and a request under the share sends every image as it was. `otherEncoded`: the request's words and its other
 *  native attachments (encoded), in bytes. */
export function planRequestImages(images: readonly RequestImage[], limits: RequestLimits, otherEncoded: number,
  opts: { platform?: string; resize?: ImageResizer; log?: (line: string) => void } = {}): Map<string, FittedImage> {
  const side = IMAGE_SEND_MAX_SIDE[limits.key]
  const plan = new Map<string, FittedImage>()
  if (side === undefined) return plan
  const encoded = (n: number) => 4 * Math.ceil(n / 3)
  const sizeOf = (i: RequestImage) => plan.get(i.sha256)?.bytes.length ?? i.bytes.length
  for (const i of images) { const fit = fitImage(i.bytes, i.media_type, i.sha256, side, opts); if (fit) plan.set(i.sha256, fit) }
  const total = () => otherEncoded + images.reduce((n, i) => n + encoded(sizeOf(i)), 0)
  const target = Math.floor(limits.request_bytes * REQUEST_IMAGE_SHARE)
  if (total() < target) return plan
  for (const i of images) {
    if (total() < target) break
    if ((plan.get(i.sha256)?.media_type ?? i.media_type) === 'image/jpeg') continue
    const jpeg = jpegImage(i.bytes, i.sha256, side, opts)
    if (jpeg && jpeg.bytes.length < sizeOf(i)) plan.set(i.sha256, jpeg)
  }
  for (const step of REQUEST_STEP_SIDES) {
    for (const i of images) {
      if (total() < target) return plan
      const now = plan.get(i.sha256) ?? (() => { try { return measureImage(i.bytes) } catch { return null } })()
      if (now === null || Math.max(now.width, now.height) <= step) continue
      const smaller = jpegImage(i.bytes, i.sha256, step, opts)
      if (smaller && smaller.bytes.length < sizeOf(i)) plan.set(i.sha256, smaller)
    }
  }
  return plan
}

/** Tests: forget the fitted images. */
export function forgetFittedImages(): void { fitted.clear() }
