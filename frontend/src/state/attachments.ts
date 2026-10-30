/** Images waiting in the composer: checked here against what the harness accepts (it measures them again on upload
 *  and is the authority), uploaded to the session when the words are sent, kept with the draft if that fails. A HEIC
 *  photo (an iPhone's — sometimes handed on under a .JPG name, so it is known by its bytes) is made a JPEG by the
 *  harness as it joins: no browser draws HEIC and no provider takes it.
 *
 *  A PDF or a video has no size bound here: it joins the message as a reference (`ref-v1`). In the desktop app a file
 *  with a file on disk behind it is named to the harness where it lies (nothing copied, nothing uploaded); a refusal of
 *  that is said, never answered by uploading instead. Only a PDF or a video with no file behind it (a browser, a file
 *  made in the page) is uploaded — in chunks of the size the harness names, each a slice of the File handed to fetch as
 *  it is: the page never reads the file into memory. Images and text go as they always did. */

import { MAX_ATTACHMENTS_PER_MESSAGE, candidateKind, FILE_LIMITS, FileRefAttachmentSchema, isFileRefAttachment, TEXT_EXTENSIONS, type Attachment, type FileRefAttachment } from '@oasis-code/contract'

/** A PDF or a video joined by reference, as the harness answered it — checked whole against the contract's schema
 *  (FileRefAttachmentSchema: an absolute `location`, kind and media type agreeing, a content hash for an upload and
 *  none for a local file), and of the origin the way it came by: `local` from the desktop app (a file of this computer
 *  read where it lies; no download), `upload` from the chunked upload (the harness's stored copy; downloadable).
 *  Anything else is no reference: null. */
export function fileRefOf(answer: unknown, origin: FileRefAttachment['origin']): FileRefAttachment | null {
  const parsed = FileRefAttachmentSchema.safeParse(answer)
  return parsed.success && parsed.data.origin === origin ? parsed.data : null
}

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', '.heic', '.heif', '.pdf', '.mp4', '.webm', '.mov', ...TEXT_EXTENSIONS.map((ext) => `.${ext}`)]
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** HEIC, as a browser names it (or does not: then the file's name says it); taken up to the size the harness converts */
const HEIF_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']
export const MAX_HEIF_BYTES = 30 * 1024 * 1024
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'heif'])
export const MAX_IMAGES = MAX_ATTACHMENTS_PER_MESSAGE

export interface PendingImage {
  id: string
  file: File
  /** an object URL for the thumbnail; revoked when the image leaves the composer */
  url: string
  name: string
  /** `converting`: a HEIC photo being made a JPEG (no thumbnail yet, and nothing is sent meanwhile); `dropping`: being
   *  removed, the harness asked to drop the chunked upload it may hold of it (nothing is sent meanwhile) */
  state: 'ready' | 'converting' | 'uploading' | 'dropping' | 'failed'
  error: string | null
  /** the upload, once the harness stored it, and the session it belongs to (a new session uploads again) */
  uploaded: { session_id: string; attachment: Attachment } | null
  /** a chunked upload under way or interrupted: how far it got (a send again goes on from where the harness says) */
  transfer?: { session_id: string; upload_id: string; chunk_bytes: number; sent: number; total: number } | null
  /** an image of the thread dragged in: the ids it is read again by (state/imageDrag.ts) */
  dragged?: { session_id: string; asset_id: string }
}

/** How a waiting file goes: a PDF or a video by reference (the desktop app's file where it lies, else a chunked
 *  upload), anything else by the one-request upload it always had. */
export function sendWay(file: Pick<Candidate, 'name' | 'type'>): 'reference' | 'upload' {
  const kind = candidateKind(file.name, file.type)
  return kind === 'pdf' || kind === 'video' ? 'reference' : 'upload'
}

/** The ways a file can go; the store hands in the real ones, the tests their own. */
export interface SendWays {
  /** the desktop app's: the File's file on disk named to the harness — null when it has none; throws a refusal */
  local: ((file: File) => Promise<FileRefAttachment | null>) | null
  /** the one-request upload of an image or a text */
  upload: (file: File, name: string) => Promise<Attachment>
  /** the chunked upload of a PDF or a video with no file behind it */
  chunked: (file: File, name: string) => Promise<FileRefAttachment>
}

/** One waiting file to the harness, by its way. A refusal of the desktop app is the file's failure: it is never
 *  uploaded instead (the shell or the harness said no to that very file). */
export async function sendAttachment(file: Pick<PendingImage, 'file' | 'name'>, ways: SendWays): Promise<Attachment> {
  if (sendWay({ name: file.name, type: file.file.type }) === 'upload') return ways.upload(file.file, file.name)
  if (ways.local) {
    const ref = await ways.local(file.file)
    if (ref) return ref
  }
  return ways.chunked(file.file, file.name)
}

/** A waiting file taken out of the composer. One whose chunked upload the harness may still hold (an interrupted
 *  upload, or a cancel it did not confirm) leaves only once the harness says it dropped that upload; if it does not,
 *  the file stays, failed, saying so — removing it again asks again. Nothing is said cleaned up that was not. */
export async function removeWaitingFile(image: Pick<PendingImage, 'transfer'>, drop: (sessionId: string, uploadId: string) => Promise<{ dropped: boolean; reason: string | null }>,
  mark: (patch: Partial<PendingImage>) => void, remove: () => void): Promise<void> {
  const transfer = image.transfer
  if (!transfer) { remove(); return }
  mark({ state: 'dropping', error: null })
  let outcome: { dropped: boolean; reason: string | null }
  try { outcome = await drop(transfer.session_id, transfer.upload_id) } catch (error) { outcome = { dropped: false, reason: errorText(error) } }
  if (outcome.dropped) { remove(); return }
  mark({ state: 'failed', error: `still here: the harness did not confirm it dropped the ${fileSize(transfer.sent)} uploaded of it (${outcome.reason ?? 'no answer'}); remove it again to ask again` })
}

/** What a thread card says of an attachment: where it is read from (a local reference: its path, live, no download —
 *  the harness never serves a file of this computer; an upload: the session's URL). */
export function attachmentCard(a: Attachment, sessionId: string): { href: string | null; line: string; location: string | null } {
  if (isFileRefAttachment(a)) {
    return a.origin === 'local'
      ? { href: null, line: `${a.media_type} · ${fileSize(a.bytes)} · live reference, read where it lies`, location: a.location }
      : { href: attachmentUrl(sessionId, a.asset_id), line: `${a.media_type} · ${fileSize(a.bytes)} · download`, location: null }
  }
  return { href: attachmentUrl(sessionId, a.asset_id), line: 'file_kind' in a ? `${a.media_type} · ${fileSize(a.bytes)} · download` : '', location: null }
}

/** An error of the desktop app's bridge as the person reads it: Electron's wrapping taken off. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '')
}

export interface Candidate { name: string; type: string; size: number }

/** Which of the dropped / pasted / chosen files join the composer, and why the others do not. */
export function admit<F extends Candidate>(pending: number, files: F[]): { accepted: F[]; refused: string[] } {
  const accepted: F[] = []
  const refused: string[] = []
  for (const file of files) {
    const name = file.name || 'pasted image'
    const heif = namedHeif(file)
    const kind = candidateKind(file.name, file.type)
    // a PDF or a video joins by reference, whatever its size: the harness hands the agent its path
    const limit = heif ? MAX_HEIF_BYTES : kind === 'pdf' || kind === 'video' ? Infinity : kind ? FILE_LIMITS[kind] : 0
    if (!heif && !kind) refused.push(`${name}: unsupported format; attach images, UTF-8 text/code, PDF or MP4/WebM/MOV (not Office, ZIP or audio)`)
    else if (file.size > limit) refused.push(`${name}: ${(file.size / 1024 / 1024).toFixed(1)} MiB is over the ${limit / 1024 / 1024} MiB limit`)
    else if (pending + accepted.length >= MAX_IMAGES) refused.push(`${name}: a message carries at most ${MAX_IMAGES} attachments`)
    else accepted.push(file)
  }
  return { accepted, refused }
}

/** Words pasted beyond this many characters join the message as a text file (a card), not as words in the composer:
 *  a box holding that much text is slow to type in, and the agents still read the file whole. */
export const LONG_PASTE_CHARS = 4000

/** A long paste as the text file it joins the message as: pasted-text-1.txt, -2, … — the first name not waiting already. */
export function pastedTextFile(text: string, waiting: readonly { name: string }[]): File {
  const taken = new Set(waiting.map((w) => w.name))
  let n = 1
  while (taken.has(`pasted-text-${n}.txt`)) n += 1
  return new File([text], `pasted-text-${n}.txt`, { type: 'text/plain' })
}

/** Whether a file says it is HEIC: by the type the browser gave it, or — given none — by its name. */
function namedHeif(file: Candidate): boolean {
  return HEIF_TYPES.includes(file.type) || (file.type === '' && /\.hei[cf]$/i.test(file.name))
}

/** Whether a file's first bytes are HEIC's (an `ftyp` box, its brand one of HEIF's): what a .JPG name may hide. */
export function isHeif(head: Uint8Array): boolean {
  if (head.length < 12) return false
  const word = (i: number) => String.fromCharCode(head[i]!, head[i + 1]!, head[i + 2]!, head[i + 3]!)
  return word(4) === 'ftyp' && HEIF_BRANDS.has(word(8))
}

/** The name of the JPEG made of a HEIC photo: its own with a .jpg ending (a name that already ends in one keeps it). */
export function jpegName(name: string): string {
  if (/\.jpe?g$/i.test(name)) return name
  return `${name.replace(/\.hei[cf]$/i, '') || 'photo'}.jpg`
}

/** A pasted image arrives nameless (or as image.png every time): give it a name the thread can show. */
export function nameOf(file: Candidate, index: number): string {
  if (file.name && file.name !== 'image.png') return file.name
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'text/plain': 'txt' } as Record<string, string>)[file.type] ?? 'txt'
  return `pasted-${index + 1}.${ext}`
}

/** The URL an attachment is read back from (the session's own route; the page's cookie authorizes it). */
export function attachmentUrl(sessionId: string, assetId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(assetId)}`
}

/** A hint for early route checks; the uploaded reference and backend sniffing are authoritative. */
export function pendingMedia(file: PendingImage): Pick<Attachment, 'name' | 'media_type'> {
  if (file.uploaded) return { name: file.uploaded.attachment.name, media_type: file.uploaded.attachment.media_type }
  const kind = candidateKind(file.name, file.file.type)
  const ext = file.name.toLowerCase().split('.').pop()
  const media_type = kind === 'text' ? 'text/plain' : kind === 'pdf' ? 'application/pdf' : kind === 'video'
    ? ext === 'mov' || ['video/mov', 'video/quicktime'].includes(file.file.type) ? 'video/quicktime' : ext === 'webm' || file.file.type === 'video/webm' ? 'video/webm' : 'video/mp4'
    : file.file.type === 'image/webp' || ext === 'webp' ? 'image/webp' : file.file.type === 'image/png' || ext === 'png' ? 'image/png' : 'image/jpeg'
  return { name: file.name, media_type }
}
export function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}


/** Prepare in place: caller reserves the list slot before starting this async work, preserving selection order. */
export async function prepareAttachment(image: PendingImage, convert: (file: File) => Promise<Blob>, present: () => boolean,
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL): Promise<Partial<PendingImage> | null> {
  const heif = isHeif(new Uint8Array(await image.file.slice(0, 12).arrayBuffer()))
  const name = heif ? jpegName(image.name) : image.name
  const file = heif ? new File([await convert(image.file)], name, { type: 'image/jpeg' }) : image.file
  if (!present()) return null
  const url = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || /\.(png|jpe?g|webp)$/i.test(name) ? urls.createObjectURL(file) : ''
  if (image.url) urls.revokeObjectURL(image.url) // only after successful preparation, including Retry file
  return { file, name, url, state: 'ready', error: null }
}

/** A retry reuses successful uploads; removals or new selections during awaits cannot silently change a send. */
export async function uploadAttachments(sessionId: string, current: () => PendingImage[],
  upload: (file: File, name: string, pending: PendingImage) => Promise<Attachment>, mark: (id: string, patch: Partial<PendingImage>) => void): Promise<string[]> {
  const pending = current(), ids: string[] = []
  if (pending.some((i) => i.state === 'converting')) throw new Error('Attachments are still being prepared')
  if (pending.some((i) => i.state === 'dropping')) throw new Error('An attachment is still being removed')
  for (const file of pending) {
    if (!current().some((i) => i.id === file.id)) throw new Error('Attachment removed; retry the message')
    if (file.uploaded?.session_id === sessionId) { ids.push(file.uploaded.attachment.asset_id); continue }
    mark(file.id, { state: 'uploading', error: null })
    try {
      const attachment = await upload(file.file, file.name, file)
      mark(file.id, { state: 'ready', uploaded: { session_id: sessionId, attachment }, transfer: null })
      ids.push(attachment.asset_id)
    } catch (error) {
      const reason = errorText(error)
      mark(file.id, { state: 'failed', error: reason })
      throw new Error(`${file.name}: ${reason}`)
    }
  }
  if (pending.map((i) => i.id).join() !== current().map((i) => i.id).join()) throw new Error('Attachments changed during upload; review and retry the message')
  return ids
}
export function destinationRefusal(destination: 'agent' | 'native-director' | 'chatgpt-director' | 'interaction-director' | 'participants', count: number): string | null {
  return count && (destination === 'chatgpt-director' || destination === 'participants') ? 'This destination takes words only. Remove attachments or choose an agent; the entire draft is kept. Nothing has been sent.' : null
}
