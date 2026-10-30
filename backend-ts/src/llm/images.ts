import { text } from '../prompt_texts.ts'
/** Images in the conversation: attached to the person's message, or returned by the tool that reads a workspace file.
 *  The server measures what it stores (the format from the bytes' own signature, never a name or a client's word; the
 *  pixel size from the header), the history keeps a reference, and only the request handed to a provider carries the
 *  bytes — read from the asset store at that moment, checked against the hash the reference was made with. A missing
 *  image or a model that takes none is said in words to the model, never dropped in silence. */

import { ImagePieceSchema, type ImageAttachment, type ImagePiece } from '@oasis-code/contract'
import { isRequest, isToolReturn, isUserPrompt, type ModelMessage, type RequestPart } from './messages.ts'
import { WrapperModel, type Model, type ModelRequestParameters, type ModelSettings, type RequestContext } from './model.ts'
import { sha256Hex } from '../store.ts'

// Application limits retained from the image-only composer, not current provider guarantees.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_SIDE = 8000

export type ImageMediaType = ImageAttachment['media_type']
export interface MeasuredImage { media_type: ImageMediaType; width: number; height: number }

/** An upload refused: the message says what was found and what is accepted. */
export class ImageRefused extends Error {
  constructor(message: string) { super(message); this.name = 'ImageRefused' }
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

function pngSize(b: Uint8Array): [number, number] | null {
  // the IHDR chunk comes first: length, "IHDR", width, height
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
  return [u32be(b, 16), u32be(b, 20)]
}

function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    if (marker === 0xff) { i += 1; continue }                        // fill bytes
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue } // no length
    const length = u16be(b, i + 2)
    // a start-of-frame segment (C0–CF but for DHT C4, JPG C8, DAC CC): precision, height, width
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [u16be(b, i + 7), u16be(b, i + 5)]
    if (marker === 0xd9 || marker === 0xda) return null               // the image data began before any frame header
    i += 2 + length
  }
  return null
}

function webpSize(b: Uint8Array): [number, number] | null {
  if (b.length < 30) return null
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ') return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff]
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const [b1, b2, b3, b4] = [b[21]!, b[22]!, b[23]!, b[24]!]
    return [1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))]
  }
  if (chunk === 'VP8X') return [1 + u24le(b, 24), 1 + u24le(b, 27)]
  return null
}

/** The format the first bytes of a file announce (their signature), or null for anything but PNG, JPEG and WebP. */
export function sniffImage(head: Uint8Array): ImageMediaType | null {
  if (head.length >= 8 && u32be(head, 0) === 0x89504e47 && u32be(head, 4) === 0x0d0a1a0a) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'image/webp'
  return null
}

/** The refusal of an image over the size limit (the upload's, and a workspace file's read as an image). */
export function checkImageBytes(size: number): void {
  if (size > MAX_IMAGE_BYTES) throw new ImageRefused(`the image is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)
}

/** The image's format and size as its bytes say, or a refusal that names what is accepted. */
export function measureImage(bytes: Uint8Array): MeasuredImage {
  if (bytes.length === 0) throw new ImageRefused('the upload is empty')
  checkImageBytes(bytes.length)
  const media_type = sniffImage(bytes)
  if (media_type === null) throw new ImageRefused('not a PNG, JPEG or WebP image (the format is read from the file itself; SVG, GIF, HEIC and others are not accepted)')
  const size = media_type === 'image/png' ? pngSize(bytes) : media_type === 'image/jpeg' ? jpegSize(bytes) : webpSize(bytes)
  if (size === null || size[0] <= 0 || size[1] <= 0) throw new ImageRefused(`the ${media_type.slice(6).toUpperCase()} header could not be read (a damaged or truncated file)`)
  const [width, height] = size
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) throw new ImageRefused(`the image is ${width}×${height} px; the limit is ${MAX_IMAGE_SIDE} px a side`)
  const broken = media_type === 'image/png' ? pngStructure(bytes) : media_type === 'image/jpeg' ? jpegStructure(bytes) : webpStructure(bytes)
  if (broken !== null) throw new ImageRefused(`the ${media_type.slice(6).toUpperCase()} file is incomplete or damaged: ${broken}`)
  return { media_type, width, height }
}

// ---- the file's structure, walked to its end ------------------------------------------------------------------
// Not a decoder: every chunk / segment is where its length says, the image data is there, the file ends where the
// format ends it. A file cut after its header (what a size check alone lets through) is refused; a complete file
// whose compressed data is itself corrupt may still pass.

const u32le = (b: Uint8Array, i: number) => b[i]! + (b[i + 1]! << 8) + (b[i + 2]! << 16) + ((b[i + 3]! << 24) >>> 0)

/** PNG: chunks from IHDR to IEND, each within the file with a matching CRC, at least one IDAT. */
function pngStructure(b: Uint8Array): string | null {
  let i = 8
  let idat = false
  for (let chunks = 0; chunks < 100_000; chunks += 1) {
    if (i + 12 > b.length) return 'it ends inside a chunk header (no IEND)'
    const length = u32be(b, i)
    const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!)
    if (i + 12 + length > b.length) return `its ${type} chunk runs past the end of the file`
    const crc = u32be(b, i + 8 + length)
    if ((Bun.hash.crc32(b.subarray(i + 4, i + 8 + length)) >>> 0) !== crc) return `its ${type} chunk fails its checksum`
    if (chunks === 0 && type !== 'IHDR') return 'it does not start with IHDR'
    if (type === 'IDAT') idat = true
    if (type === 'IEND') return idat ? null : 'it has no image data (IDAT)'
    i += 12 + length
  }
  return 'too many chunks'
}

/** JPEG: the marker segments within the file up to a start of scan, the scan's data, and an end-of-image marker. */
function jpegStructure(b: Uint8Array): string | null {
  let i = 2
  for (;;) {
    while (i < b.length && b[i] === 0xff && b[i + 1] === 0xff) i += 1
    if (i + 4 > b.length || b[i] !== 0xff) return 'it ends before its image data'
    const marker = b[i + 1]!
    if (marker === 0xd9) return 'it ends before its image data'
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue }
    const length = (b[i + 2]! << 8) + b[i + 3]!
    if (length < 2 || i + 2 + length > b.length) return `a segment (0xFF${marker.toString(16).toUpperCase()}) runs past the end of the file`
    i += 2 + length
    if (marker === 0xda) break
  }
  // the entropy-coded data, then EOI (a stuffed 0xFF00 or a restart marker is data)
  for (let j = i; j + 1 < b.length; j += 1) {
    if (b[j] !== 0xff) continue
    const next = b[j + 1]!
    if (next === 0xd9) return j > i ? null : 'its scan has no data'
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) continue
    // another marker between scans (a progressive JPEG): its segment is skipped whole
    if (j + 4 > b.length) break
    const length = (b[j + 2]! << 8) + b[j + 3]!
    if (length < 2 || j + 2 + length > b.length) return 'a segment runs past the end of the file'
    j += 1 + length
  }
  return 'it has no end-of-image marker (the scan is cut)'
}

/** WebP: the RIFF size within the file, every chunk within it, an image chunk (VP8 / VP8L) among them. */
function webpStructure(b: Uint8Array): string | null {
  if (b.length < 12) return 'it ends inside its header'
  const riff = u32le(b, 4) + 8
  if (riff > b.length) return `its RIFF header says ${riff} bytes; the file has ${b.length}`
  let i = 12
  let image = false
  while (i + 8 <= riff) {
    const type = String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!)
    const size = u32le(b, i + 4)
    if (i + 8 + size > riff) return `its ${type.trim()} chunk runs past the end of the file`
    if ((type === 'VP8 ' && size >= 10) || (type === 'VP8L' && size >= 5)) image = true
    i += 8 + size + (size % 2)
  }
  return image ? null : 'it has no image data (VP8 / VP8L)'
}

export const EXTENSIONS: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

export type { ImagePiece }

export function imagePiece(attachment: ImageAttachment): ImagePiece {
  return { kind: 'image', ...attachment }
}

export function isImagePiece(value: unknown): value is ImagePiece {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { kind?: unknown }).kind === 'image'
    && ImagePieceSchema.safeParse(value).success
}

/** Whether a tool return's content carries an image: a piece as one of the values of its (dict) content. */
export function returnHasImage(content: unknown): content is Record<string, unknown> {
  return typeof content === 'object' && content !== null && !Array.isArray(content) && Object.values(content).some(isImagePiece)
}

/** The bytes of an attachment, or null when the store no longer has them as they were referenced. */
export type ImageReader = (image: ImageAttachment) => Uint8Array | null

const partHasImage = (p: RequestPart): boolean =>
  (isUserPrompt(p) && Array.isArray(p.content) && p.content.some(isImagePiece)) || (isToolReturn(p) && returnHasImage(p.content))

/** The messages with every image reference — in the person's words, or in a tool's return — carrying its bytes
 *  (base64); incompatible routes and missing/damaged bytes fail explicitly, never rewriting the replay.
 *  Messages without images come back as they were. */
export function hydrateImages(messages: ModelMessage[], read: ImageReader, acceptsImages: boolean, modelName: string): ModelMessage[] {
  const hydrate = (image: ImagePiece): ImagePiece | string => {
    if (!acceptsImages) throw new Error(`${modelName} does not accept images: ${image.name}`)
    const bytes = read(image)
    if (bytes === null || bytes.length !== image.bytes || sha256Hex(bytes) !== image.sha256) throw new Error(`image missing or damaged: ${image.name}`)
    return { ...image, data: Buffer.from(bytes).toString('base64') }
  }
  let changed = false
  const out = messages.map((message) => {
    if (!isRequest(message) || !message.parts.some(partHasImage)) return message
    changed = true
    const parts = message.parts.map((part): RequestPart => {
      if (isUserPrompt(part) && Array.isArray(part.content)) return { ...part, content: part.content.map((piece) => (isImagePiece(piece) ? hydrate(piece) : piece)) }
      if (isToolReturn(part) && returnHasImage(part.content)) {
        return { ...part, content: Object.fromEntries(Object.entries(part.content).map(([k, v]) => [k, isImagePiece(v) ? hydrate(v) : v])) }
      }
      return part
    })
    return { ...message, parts }
  })
  return changed ? out : messages
}

/** The provider boundary for images: the request the wrapped model sends carries the bytes; the caller's messages
 *  (the history, the stash, the record, the estimate) keep the references. */
export class ImageHydration extends WrapperModel {
  constructor(wrapped: Model, private readonly read: ImageReader, private readonly acceptsImages: boolean) { super(wrapped) }
  override request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext) {
    return this.wrapped.request(hydrateImages(messages, this.read, this.acceptsImages, this.model_name), settings, params, ctx)
  }
  override requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext) {
    return this.wrapped.requestStream(hydrateImages(messages, this.read, this.acceptsImages, this.model_name), settings, params, ctx)
  }
}

/** Whether a configured route declares image input (`capabilities.images: true`); anything else is no. */
export function acceptsImages(capabilities: Record<string, unknown>): boolean {
  return capabilities.images === true
}

/** Reads an attachment's bytes through a lookup of its stored path, refusing bytes whose hash is not the reference's. */
export function storeReader(lookup: (assetId: string) => { storage_path: string } | null, readPath: (rel: string) => Uint8Array): ImageReader {
  return (image) => {
    const asset = lookup(image.asset_id)
    if (asset === null) return null
    let bytes: Uint8Array
    try { bytes = readPath(asset.storage_path) } catch { return null }
    return bytes.length === image.bytes && sha256Hex(bytes) === image.sha256 ? bytes : null
  }
}

/** Decide a NEW tool result's representation once, before it enters canonical history. Non-vision tools still
 * report their action/outcome/outline; their screenshot is an explicit note from the outset. This is NOT a
 * replay fallback: a history image reference on an incompatible route still fails hydration/preflight. */
export function imageToolPiece(attachment: ImageAttachment, capabilities: Record<string, unknown>): ImagePiece | string {
  return acceptsImages(capabilities) ? imagePiece(attachment) : text('image.unsupported', { name: attachment.name })
}
