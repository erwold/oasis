/** The session share's pictures: each source image of the snapshot (the backend's session-owned PNG/JPEG/WebP,
 *  base64) is checked, decoded and drawn again by this page, so what the file carries is the page's own encoding —
 *  no EXIF/XMP/ICC/text chunk of the source survives — and never the source bytes.
 *
 *  One at a time: decode (the bytes must start as the declared raster and decode as an image of the declared size),
 *  draw at most PAGE_IMAGE_LIMITS.max_side on its longest side, encode (WebP, else PNG), then check the OUTPUT again —
 *  its signature, its size within the per-image and total budgets, and that it decodes at the size drawn — and release
 *  the bitmap and canvas before the next. A picture failing a check is left out and counted; the source string is
 *  not kept by the result. Text redaction does not reach pixels: what a screenshot shows is shared as shown. */

import type { ShareImage } from '@oasis-code/contract'
import { bytesToBase64, type PageOmissions, type PreparedShareImage } from './shareHtml.ts'

export const PAGE_IMAGE_LIMITS = {
  /** the longest side drawn into the file */
  max_side: 2_400,
  /** bytes of one re-encoded picture */
  max_image_bytes: 4 * 1024 * 1024,
  /** bytes of every re-encoded picture together */
  max_total_bytes: 16 * 1024 * 1024,
} as const

export type RasterType = 'image/png' | 'image/jpeg' | 'image/webp'

/** The raster type the bytes' signature says, or null (SVG, HTML, PDF, GIF, anything else). */
export function sniffRaster(bytes: Uint8Array): RasterType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

export function base64ToBytes(b64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return null
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch { return null }
}

/** The size to draw: the source's, scaled down so its longest side is at most `maxSide`. */
export function drawSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { width, height }
  const k = maxSide / longest
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** What decodes and encodes pictures: the browser's (browserCodec) in the page, a fake in tests. */
export interface ImageCodec<D> {
  decode(bytes: Uint8Array, type: RasterType): Promise<{ image: D; width: number; height: number }>
  encode(image: D, width: number, height: number): Promise<Uint8Array>
  release(image: D): void
}

export interface PreparedImages {
  images: Map<string, PreparedShareImage>
  omissions: PageOmissions
  /** bytes of every carried picture as re-encoded (what the file's data URLs hold before base64) */
  bytes: number
}

/** Re-encode the snapshot's pictures one at a time. `signal` stops between pictures (a newer generation won). `spent`:
 *  the bytes pictures prepared before these already hold of the page's total budget (a task's sessions share it). */
export async function prepareShareImages<D>(sources: readonly ShareImage[], codec: ImageCodec<D>, signal?: AbortSignal, spent = 0): Promise<PreparedImages> {
  const images = new Map<string, PreparedShareImage>()
  const omissions: PageOmissions = { images_rejected: 0, images_over_page_budget: 0 }
  let total = spent
  for (const src of sources) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError')
    const bytes = base64ToBytes(src.data_base64)
    if (!bytes || bytes.length !== src.bytes || sniffRaster(bytes) !== src.media_type) { omissions.images_rejected++; continue }
    let decoded: { image: D; width: number; height: number } | null = null
    let encoded: Uint8Array | null = null
    let size = { width: 0, height: 0 }
    try {
      decoded = await codec.decode(bytes, src.media_type)
      // the declared size, or its transpose (a JPEG's orientation applied by the decoder)
      const same = decoded.width === src.width && decoded.height === src.height
      const turned = decoded.width === src.height && decoded.height === src.width
      if (!same && !turned) throw new Error('size')
      size = drawSize(decoded.width, decoded.height, PAGE_IMAGE_LIMITS.max_side)
      encoded = await codec.encode(decoded.image, size.width, size.height)
    } catch { encoded = null } finally { if (decoded) codec.release(decoded.image) }
    const type = encoded ? sniffRaster(encoded) : null
    if (!encoded || !type) { omissions.images_rejected++; continue }
    if (encoded.length > PAGE_IMAGE_LIMITS.max_image_bytes || total + encoded.length > PAGE_IMAGE_LIMITS.max_total_bytes) { omissions.images_over_page_budget++; continue }
    // the output again: it must decode, at the size drawn
    let check: { image: D; width: number; height: number } | null = null
    let ok = false
    try { check = await codec.decode(encoded, type); ok = check.width === size.width && check.height === size.height } catch { ok = false } finally { if (check) codec.release(check.image) }
    if (!ok) { omissions.images_rejected++; continue }
    total += encoded.length
    images.set(src.key, { dataUrl: `data:${type};base64,${bytesToBase64(encoded)}`, width: size.width, height: size.height, bytes: encoded.length, mediaType: type })
  }
  return { images, omissions, bytes: total - spent }
}

/** The browser's codec: createImageBitmap (refuses anything that is not an image it can decode), a canvas, WebP at
 *  0.9 (PNG where the browser cannot write WebP). Nothing is fetched: the bytes are a Blob made here. */
export const browserCodec: ImageCodec<ImageBitmap> = {
  async decode(bytes, type) {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }))
    return { image: bitmap, width: bitmap.width, height: bitmap.height }
  },
  async encode(bitmap, width, height) {
    let blob: Blob | null
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no canvas')
      ctx.drawImage(bitmap, 0, 0, width, height)
      blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
      canvas.width = 0; canvas.height = 0
    } else {
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no canvas')
      ctx.drawImage(bitmap, 0, 0, width, height)
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9))
      canvas.width = 0; canvas.height = 0
    }
    if (!blob) throw new Error('not encoded')
    return new Uint8Array(await blob.arrayBuffer())
  },
  release(bitmap) { bitmap.close() },
}
