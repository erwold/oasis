/** An image of the thread dragged into the composer. Only a drag this page began on one of its own images is taken:
 *  its start records the session, the asset and a random nonce in this module (never on `window`), the drag carries
 *  the three, and the drop takes it only when all three are the recorded ones — once; the drag's end forgets it. A
 *  drag of the same type from anywhere else (a sandboxed frame, another tab, another app) is refused before anything
 *  is read, whatever ids it names. Nothing else is read from the drag. The bytes come from that session's own attachment route (the harness
 *  answers only for an attachment of that session), their type from the harness's answer, their size from decoding
 *  them; anything the harness does not answer as a PNG, JPEG or WebP image is refused. An image of the session the
 *  composer writes to joins as already uploaded (it is sent by its id); another session's is uploaded as any file. */

import type { ImageAttachment } from '@oasis-code/contract'
import { attachmentUrl, MAX_IMAGE_BYTES, type PendingImage } from './attachments.ts'

export const IMAGE_DRAG_MIME = 'application/x-oasis-image'

export interface DraggedImage { session_id: string; asset_id: string }

const ID = /^[A-Za-z0-9_-]{1,128}$/
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
type ImageType = typeof IMAGE_TYPES[number]
const EXTENSIONS: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

export interface DragTicket extends DraggedImage { nonce: string }
const NONCE = /^[A-Za-z0-9-]{16,64}$/

/** The drag this document began on one of its images, until it is dropped or ends. Module-private. */
let active: DragTicket | null = null

/** A drag of the image `asset_id` of session `session_id` begins on this page: recorded, and what it carries. */
export function beginImageDrag(session_id: string, asset_id: string): string {
  active = { session_id, asset_id, nonce: crypto.randomUUID() }
  return JSON.stringify(active)
}

/** The drag of this page ended (dropped anywhere, or cancelled): it is forgotten. */
export function endImageDrag(): void {
  active = null
}

/** What a drag carries, read strictly: exactly a session id, an asset id and a nonce, well formed; else null. */
export function draggedImageOf(raw: unknown): DragTicket | null {
  if (typeof raw !== 'string' || !raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'asset_id,nonce,session_id') return null
  const { session_id, asset_id, nonce } = value as Record<string, unknown>
  if (typeof session_id !== 'string' || typeof asset_id !== 'string' || typeof nonce !== 'string') return null
  if (!ID.test(session_id) || !ID.test(asset_id) || !NONCE.test(nonce)) return null
  return { session_id, asset_id, nonce }
}

/** The drop of a drag: its image when it is the drag this page began (session, asset and nonce all as recorded),
 *  else null. Either way the recorded drag is spent: a drop is taken once. */
export function takeDraggedImage(raw: unknown): DraggedImage | null {
  const ticket = draggedImageOf(raw)
  const begun = active
  active = null
  if (ticket === null || begun === null) return null
  if (ticket.session_id !== begun.session_id || ticket.asset_id !== begun.asset_id || ticket.nonce !== begun.nonce) return null
  return { session_id: ticket.session_id, asset_id: ticket.asset_id }
}

/** Whether a drag over the page carries an image of the thread. */
export function carriesDraggedImage(types: readonly string[]): boolean {
  return types.includes(IMAGE_DRAG_MIME)
}

/** The name an image downloads under: the harness's label when it names a picture (its last segment), else the asset id. */
export function downloadNameOf(image: { asset_id: string; label: string | null }): string {
  const last = (image.label ?? '').split(/[\\/]/).pop() ?? ''
  return /\.(png|jpe?g|webp)$/i.test(last) ? last : `${image.asset_id}.png`
}

export interface ReadImage { file: File; attachment: ImageAttachment }

/** The bounds of an image read for a drop: the upload's (attachments.ts MAX_IMAGE_BYTES) and the harness's side limit
 *  (backend llm/images.ts MAX_IMAGE_SIDE). */
export const MAX_DROPPED_SIDE = 8000

/** A body read to its end, refused (and cancelled) as soon as it passes `limit` bytes, whatever its length header said. */
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) { await reader.cancel().catch(() => {}); throw new Error(`the image is over ${limit / 1024 / 1024} MiB`) }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

/** The dragged image read from the harness: its bytes from its session's attachment route (at most the upload's
 *  limit), its type as the harness answered it, its size as decoded (at most 8000 pixels a side). Throws the reason
 *  it is not one; a body refused unread is cancelled. */
export async function readDraggedImage(ref: DraggedImage, deps: {
  fetch: typeof fetch
  measure: (blob: Blob) => Promise<{ width: number; height: number }>
}): Promise<ReadImage> {
  const response = await deps.fetch(attachmentUrl(ref.session_id, ref.asset_id))
  const refuse = async (reason: string): Promise<never> => { await response.body?.cancel().catch(() => {}); throw new Error(reason) }
  if (!response.ok) return refuse(`the image is not available (${response.status})`)
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!(IMAGE_TYPES as readonly string[]).includes(type)) return refuse('not a PNG, JPEG or WebP image')
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return refuse(`the image is over ${MAX_IMAGE_BYTES / 1024 / 1024} MiB`)
  const bytes = await boundedBytes(response, MAX_IMAGE_BYTES)
  let size: { width: number; height: number }
  try { size = await deps.measure(new Blob([bytes as Uint8Array<ArrayBuffer>], { type })) } catch { throw new Error('the image could not be read') }
  if (!(size.width > 0 && size.height > 0)) throw new Error('the image could not be read')
  if (size.width > MAX_DROPPED_SIDE || size.height > MAX_DROPPED_SIDE) throw new Error(`the image is ${size.width}×${size.height} px; the limit is ${MAX_DROPPED_SIDE} px a side`)
  const name = `${ref.asset_id}.${EXTENSIONS[type as ImageType]}`
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  const sha256 = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type })
  return { file, attachment: { asset_id: ref.asset_id, media_type: type as ImageType, bytes: bytes.length, sha256, width: size.width, height: size.height, name } }
}

/** The page's decoder: an image's size, or a refusal for bytes that are not one. */
export async function measureImage(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob)
  try { return { width: bitmap.width, height: bitmap.height } } finally { bitmap.close() }
}

/** The waiting image a read drop becomes in the composer of `owner` (a session id, or the start screen): already
 *  uploaded when the image is that session's own. */
export function readyFromDragged(ref: DraggedImage, read: ReadImage, owner: string, url: string): Partial<PendingImage> {
  return {
    file: read.file, name: read.file.name, url, state: 'ready', error: null,
    uploaded: ref.session_id === owner ? { session_id: owner, attachment: read.attachment } : null,
  }
}
