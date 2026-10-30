import { validatePdf } from './pdf.ts'
/** Bounded, deliberately small upload format surface. No remote decoders or provider Files API. */
import { candidateKind, extensionOf, FILE_LIMITS, isTextMime, type FileAttachment } from '@oasis-code/contract'
import { ImageRefused, measureImage, sniffImage } from './images.ts'

export class FileRefused extends ImageRefused {}
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length > FILE_LIMITS.text) throw new FileRefused('text attachments are limited to 1 MiB')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw new FileRefused('text must be valid UTF-8 (no binary or legacy encoding)') }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text)) throw new FileRefused('binary/control characters are not allowed in a UTF-8 attachment')
  return text
}
const ascii = (b: Uint8Array, start: number, end: number) => Buffer.from(b.subarray(start, end)).toString('latin1')
const u32 = (b: Uint8Array, i: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i)

/** ISO BMFF: complete boxes, recognized ftyp, a moov/trak/mdia/hdlr video track, nonempty mdat. */
function bmff(b: Uint8Array): 'video/mp4' | 'video/quicktime' {
  let brand = '', brands: string[] = [], video = false, data = false, movie = false
  const boxes = (start: number, end: number, path: string[], depth = 0) => {
    if (depth > 5) throw new FileRefused('video box nesting is too deep')
    let p = start
    while (p < end) {
      if (p + 8 > end) throw new FileRefused('video has a truncated box header')
      const type = ascii(b, p + 4, p + 8)
      let size = u32(b, p), header = 8
      if (size === 1) { if (p + 16 > end || u32(b, p + 8) !== 0) throw new FileRefused('video box size is invalid'); size = u32(b, p + 12); header = 16 }
      if (size === 0) size = end - p
      if (size < header || size > end - p) throw new FileRefused('video box runs past the file')
      const body = p + header, stop = p + size
      if (!path.length && type === 'ftyp') { if (size < header + 8 || (size - header) % 4) throw new FileRefused('invalid video ftyp'); brand = ascii(b, body, body + 4); brands = [brand]; for (let i = body + 8; i < stop; i += 4) brands.push(ascii(b, i, i + 4)) }
      if (!path.length && type === 'mdat' && stop > body) data = true
      if (!path.length && type === 'moov') movie = true
      if (path.join('/') === 'moov/trak/mdia' && type === 'hdlr' && stop - body >= 12 && ascii(b, body + 8, body + 12) === 'vide') video = true
      if ((path.length === 0 && type === 'moov') || (path.join('/') === 'moov' && type === 'trak') || (path.join('/') === 'moov/trak' && type === 'mdia')) boxes(body, stop, [...path, type], depth + 1)
      p = stop
    }
  }
  boxes(0, b.length, [])
  if (!brands.some((v) => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'av01', 'dash', 'qt  '].includes(v)) || !movie || !video || !data) throw new FileRefused('MP4/MOV requires a recognized ftyp, video track and media data (audio-only is not supported)')
  return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4'
}

/** WebM EBML elements: bounded sizes, DocType webm, Tracks/TrackEntry video type, Cluster block data. */
function webm(b: Uint8Array): void {
  let doc = false, video = false, data = false, segment = false
  const vint = (p: number, id: boolean): [number, number, boolean] => {
    if (p >= b.length || b[p] === 0) throw new FileRefused('invalid WebM element')
    let n = 1, mask = 128
    while (!(b[p]! & mask)) { n++; mask >>= 1 }
    if (n > (id ? 4 : 8) || p + n > b.length) throw new FileRefused('truncated WebM element')
    let value = id ? b[p]! : b[p]! & (mask - 1), unknown = !id && value === mask - 1
    for (let j = 1; j < n; j++) { value = value * 256 + b[p + j]!; unknown &&= b[p + j] === 255 }
    return [value, n, unknown]
  }
  const segmentChildren = new Set([0x114d9b74, 0x1549a966, 0x1f43b675, 0x1654ae6b, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367])
  const walk = (start: number, end: number, parent: number, depth: number, unknownCluster = false): number => {
    if (depth > 5) throw new FileRefused('WebM nesting is too deep')
    let p = start
    while (p < end) {
      const [id, ni] = vint(p, true), [size, ns, unknown] = vint(p + ni, false)
      if (unknownCluster && segmentChildren.has(id)) return p // next Segment-level sibling, not part of this Cluster
      if (parent === 0x1f43b675 && segmentChildren.has(id)) throw new FileRefused('Segment element inside a sized Cluster')
      const body = p + ni + ns
      let stop = unknown && [0x18538067, 0x1f43b675].includes(id) ? end : body + size
      if (body > end || (unknown && !(id === 0x18538067 && parent === 0) && !(id === 0x1f43b675 && parent === 0x18538067)) || !Number.isSafeInteger(stop) || stop > end || stop < body) throw new FileRefused('WebM element runs past the file or uses unsupported unknown size')
      if (parent === 0x1a45dfa3 && id === 0x4282) doc = ascii(b, body, stop) === 'webm'
      if (parent === 0xae && id === 0x83 && stop === body + 1 && b[body] === 1) video = true
      if (parent === 0x1f43b675 && id === 0xa3 || parent === 0xa0 && id === 0xa1) {
        const [track, length, indefinite] = vint(body, false)
        if (indefinite || track < 1 || body + length + 3 >= stop) throw new FileRefused('truncated WebM block')
        data = true
      }
      if (parent === 0 && id === 0x18538067) segment = true
      const descend = (parent === 0 && [0x1a45dfa3, 0x18538067].includes(id)) || (parent === 0x18538067 && [0x1654ae6b, 0x1f43b675].includes(id)) || (parent === 0x1654ae6b && id === 0xae) || (parent === 0x1f43b675 && id === 0xa0)
      if (descend) stop = walk(body, stop, id, depth + 1, unknown && id === 0x1f43b675)
      p = stop
    }
    return p
  }
  walk(0, b.length, 0, 0)
  if (!doc || !segment || !video || !data) throw new FileRefused('WebM requires DocType webm, a video track and a Cluster/SimpleBlock')
}

export function binaryFileKind(head: Uint8Array): 'pdf' | 'video' | null {
  if (ascii(head, 0, 5) === '%PDF-') return 'pdf'
  if (ascii(head, 4, 8) === 'ftyp' || (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)) return 'video'
  return null
}
export type MeasuredFile = Pick<FileAttachment, 'file_kind' | 'representation' | 'media_type'>
export function measureAttachment(b: Uint8Array, name = '', mime = '') {
  const binary = binaryFileKind(b)
  const image = sniffImage(b)
  const kind = image ? 'image' : binary ?? candidateKind(name, '')
  if (!kind) throw new FileRefused('unsupported file: use PNG/JPEG/WebP, UTF-8 text/code, PDF, MP4/WebM/MOV; Office, ZIP and audio are not supported')
  if (b.length > FILE_LIMITS[kind]) throw new FileRefused(`${kind} attachment exceeds ${FILE_LIMITS[kind] / 1024 / 1024} MiB`)
  let measured: ReturnType<typeof measureImage> | MeasuredFile
  if (image) measured = measureImage(b)
  else if (binary === 'pdf') { try { validatePdf(b) } catch (error) { throw new FileRefused((error as Error).message) }; measured = { file_kind: 'pdf', representation: 'native-v1', media_type: 'application/pdf' } }
  else if (binary === 'video') {
    const type = ascii(b, 4, 8) === 'ftyp' ? bmff(b) : (webm(b), 'video/webm' as const)
    measured = { file_kind: 'video', representation: 'native-v1', media_type: type }
  } else {
    if (kind !== 'text' || candidateKind(name, '') !== 'text') throw new FileRefused('file signature does not match its declared format')
    // A valid UTF-8 byte sequence is not in itself a text file.
    if (hasBinaryMagic(b)) throw new FileRefused('binary signature cannot be attached as text')
    decodeText(b)
    measured = { file_kind: 'text', representation: 'utf8-v1', media_type: 'text/plain' }
  }
  const ext = extensionOf(name)
  const known: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }
  if (known[ext] && known[ext] !== measured.media_type || candidateKind(name, '') === 'text' && measured.media_type !== 'text/plain') throw new FileRefused('file extension conflicts with the detected format')
  const declared = mime.split(';')[0]!.trim().toLowerCase()
  const textMime = isTextMime(declared)
  if (declared && declared !== 'application/octet-stream' && declared !== measured.media_type && !(measured.media_type === 'text/plain' && textMime) && !(measured.media_type === 'video/quicktime' && declared === 'video/mov')) throw new FileRefused('Content-Type conflicts with the detected file format')
  return measured
}

/** Full signatures, not English prefixes (PKCE/RIFF/ID3 prose is valid text). */
function hasBinaryMagic(b: Uint8Array): boolean {
  const starts = (...magic: number[]) => magic.every((n, i) => b[i] === n)
  return starts(0x50, 0x4b, 3, 4) || starts(0x50, 0x4b, 5, 6) || starts(0x50, 0x4b, 7, 8)
    || ['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6))
    || ascii(b, 0, 4) === 'RIFF' && ['WAVE', 'AVI ', 'WEBP'].includes(ascii(b, 8, 12))
    || ascii(b, 0, 4) === 'OggS' && b[4] === 0
    || ascii(b, 0, 3) === 'ID3' && [2, 3, 4].includes(b[3]!) && b.length >= 10 && b.slice(6, 10).every((n) => n < 128)
}
