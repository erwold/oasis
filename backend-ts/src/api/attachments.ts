/** Images attached to a session's messages: uploaded as the raw bytes of the request (the server reads the format
 *  and the size from them and names the asset itself), read back only under the session they belong to. A chat
 *  names them by asset id; `attachmentsFor` checks each belongs to that session. */

import { Hono } from 'hono'
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  candidateKind, FILE_LIMITS, isFileRefAttachment, LocalAttachmentBodySchema, MAX_ATTACHMENTS_PER_MESSAGE,
  type Attachment, type FileRefAttachment, type ImageAttachment, type Session,
} from '@oasis-code/contract'
import * as repo from '../db/repo.ts'
import { newId } from '../ids.ts'
import { heifToJpeg, MAX_HEIF_BYTES } from '../llm/heif.ts'
import { EXTENSIONS, ImageRefused, MAX_IMAGE_BYTES, measureImage } from '../llm/images.ts'
import { SITE_ICON_ROLE, siteIconForHost } from '../agent/tools/web.ts'
import { binaryFileKind, measureAttachment } from '../llm/files.ts'
import { assetAttachment, attachmentReader } from '../llm/attachments.ts'
import { classifyRef, deniedRoots, insertLocalRef, insertUploadRef, inspectLocalFile, recordedRef, REF_EXTENSIONS, REF_HEAD_BYTES, RefRefused, StagedUpload } from '../llm/ref_files.ts'
import { sha256Hex } from '../store.ts'
import { HEADER, tokensMatch } from './auth.ts'
import { HttpError, parseBody, type Api } from './common.ts'
import { requireSession, type AppState } from './state.ts'
import { cleanName, finishStaged, uploadsOf } from './uploads.ts'

export const ATTACHMENT_ROLE = 'attachment'

export { cleanName }

/** What an attachment is read from and kept in: the database and the asset store (the app's, or a run's). */
export type AttachmentStore = Pick<AppState, 'conn' | 'store'>

/** The session's attachment by id. An image or a legacy file is read and checked against its record; a reference
 *  (`ref-v1`) is checked against its record only — no file of it is opened, read or hashed here. */
function attachmentOf(state: AttachmentStore, session: Session, assetId: string): Attachment {
  const asset = repo.getAsset(state.conn, assetId)
  if (!asset || asset.project_id !== session.project_id || asset.meta.role !== ATTACHMENT_ROLE || asset.meta.session_id !== session.id) throw new HttpError(404, `no attachment ${assetId} in this session`)
  let attachment: Attachment
  try { attachment = assetAttachment(asset) } catch { throw new HttpError(409, 'invalid attachment metadata') }
  if (isFileRefAttachment(attachment)) {
    if (recordedRef(asset, attachment, session.project_id, session.id, storeRoot(state))) throw new HttpError(409, 'invalid attachment metadata')
    return attachment
  }
  if (!readAttachment(state, session, attachment)) throw new HttpError(409, `attachment missing or damaged: ${attachment.name}`)
  return attachment
}

const storeRoot = (state: AttachmentStore): string => { try { return realpathSync.native(state.store.root) } catch { return state.store.root } }

function readAttachment(state: AttachmentStore, session: Session, attachment: Attachment): Uint8Array | null {
  return attachmentReader((id) => repo.getAsset(state.conn, id), (path) => state.store.read(path), session.project_id, session.id)(attachment)
}

/** Stop reading and cancel the body as soon as its bound is exceeded, including chunked requests. */
export async function readBounded(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > limit) { await request.body?.cancel(); throw new HttpError(413, `attachment exceeds ${limit / 1024 / 1024} MiB`) }
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > limit) { await reader.cancel(); throw new HttpError(413, `attachment exceeds ${limit / 1024 / 1024} MiB`) }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

/** An image or a UTF-8 text the original POST took whole (bounded), kept as before. Bytes that are a PDF or a video
 *  become an upload reference (`ref-v1`): no new legacy `native-v1` reference is made. */
export function saveFileAttachment(state: AttachmentStore & Pick<AppState, 'settings'>, session: Session, bytes: Uint8Array, rawName?: string, mime = ''): Attachment {
  const declared = candidateKind(rawName ?? '', '')
  // a PDF or a video under a name that says neither an image nor a text: a reference; under such a name, the
  // conflict is refused below as before
  if (binaryFileKind(bytes) && declared !== 'image' && declared !== 'text') return refFromBytes(state, session, bytes, rawName ?? '', mime)
  const name = cleanName(rawName, 'bin')
  const measured = measureAttachment(bytes, name, mime)
  if (!('file_kind' in measured)) return saveAttachment(state, session, bytes, rawName)
  if (measured.file_kind !== 'text') throw new ImageRefused('file signature does not match its declared format')
  const ext = measured.file_kind === 'text' ? 'txt' : measured.file_kind === 'pdf' ? 'pdf' : measured.media_type === 'video/quicktime' ? 'mov' : measured.media_type.split('/')[1]!
  const asset = state.store.save(state.conn, session.project_id, measured.file_kind === 'text' ? 'text' : 'data', bytes, {
    ext, meta: { ...measured, name, role: ATTACHMENT_ROLE, session_id: session.id },
  })
  return attachmentOf(state, session, asset.id)
}

/** Bytes already in memory (a PDF or a video under another name or type) made an upload reference: written once to
 *  the staging folder, hashed once, named by its first bytes, renamed into the store. */
function refFromBytes(state: AttachmentStore & Pick<AppState, 'settings'>, session: Session, bytes: Uint8Array, rawName: string, mime: string): FileRefAttachment {
  const dir = join(state.settings.data_dir, 'uploads')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const staged = join(dir, `${newId('up')}.part`)
  writeFileSync(staged, bytes, { flag: 'wx', mode: 0o600 })
  try {
    const kind = classifyRef(rawName, bytes.subarray(0, REF_HEAD_BYTES), mime)
    return insertUploadRef(state.conn, state.store, state.settings.data_dir, session.project_id, session.id, staged,
      { name: cleanName(rawName, REF_EXTENSIONS[kind.media_type] ?? 'bin'), media_type: kind.media_type, file_kind: kind.file_kind, bytes: bytes.length, sha256: sha256Hex(bytes) })
  } catch (error) {
    rmSync(staged, { force: true })
    if (error instanceof RefRefused) throw new HttpError(error.status, error.message)
    throw error
  }
}

/** The attachments a chat names, each checked to be an image uploaded to this session. */
export function attachmentsFor(state: AppState, session: Session, ids: string[]): Attachment[] {
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new HttpError(400, 'a message carries at most 8 attachments')
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'an attachment is named twice')
  return ids.map((id) => {
    try { return attachmentOf(state, session, id) } catch (error) {
      if (error instanceof HttpError) throw new HttpError(400, error.message)
      throw error
    }
  })
}

/** An image kept with a session (an upload, a picture the director's answer showed, an image file a run read from its
 *  workspace): measured from its bytes, named, stored content-addressed as the session's attachment — a copy, so the
 *  reference keeps its bytes whatever later happens to the file. Throws ImageRefused for bytes that are not a
 *  supported image or are over the limit. */
export function saveAttachment(state: AttachmentStore, session: Session, bytes: Uint8Array, rawName: string | undefined): ImageAttachment {
  const measured = measureImage(bytes)
  const ext = EXTENSIONS[measured.media_type]
  const name = cleanName(rawName, ext)
  const asset = state.store.save(state.conn, session.project_id, 'image', bytes, {
    ext, meta: { role: ATTACHMENT_ROLE, session_id: session.id, media_type: measured.media_type, width: measured.width, height: measured.height, name },
  })
  if (asset.sha256 !== sha256Hex(bytes)) throw new Error('the stored image does not match its bytes')
  return attachmentOf(state, session, asset.id) as ImageAttachment
}

/** The whole of a staged file (one the original POST took without a name, under the image bound). */
async function stagedBytes(staged: StagedUpload): Promise<Uint8Array> {
  await staged.finish()
  try { return new Uint8Array(await Bun.file(staged.path).arrayBuffer()) } finally { await staged.discard() }
}

/** An upload reference's bytes, streamed from the store (byte ranges for a player), never read whole or hashed here;
 *  a local file attached by its path is not served (no route reads the person's files for a page). */
function serveRef(ref: FileRefAttachment, rangeHeader: string | undefined): Response {
  if (ref.origin === 'local') throw new HttpError(403, `${ref.name} is attached by its path on this machine (${ref.location}); it is not served — open it where it is`)
  let fd: number
  try { fd = openSync(ref.location, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { throw new HttpError(409, 'attachment missing or damaged') }
  let size: number
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size !== ref.bytes) throw new HttpError(409, 'attachment missing or damaged')
    size = st.size
  } finally { closeSync(fd) }
  const headers: Record<string, string> = {
    'content-type': ref.media_type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable',
    'content-security-policy': "default-src 'none'; sandbox", 'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(ref.name)}`,
  }
  const file = Bun.file(ref.location)
  const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? '')
  if (range && (range[1] || range[2]) && size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
    return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } })
  }
  return new Response(file, { headers: { ...headers, 'content-length': String(size) } })
}

export function attachmentUrlOf(sessionId: string, assetId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(assetId)}`
}

export function attachmentRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api

  const uploads = uploadsOf(state)

  // the original upload: an image or a UTF-8 text as before (bounded, measured whole); a PDF or a video — by its name
  // or type, or by its first bytes when neither says — streamed into an upload reference (written once, hashed as it
  // goes; no business limit: one request is bounded by the server's body limit, a larger file uses the chunked upload)
  app.post('/api/sessions/:session_id/attachments', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const name = c.req.query('name')
    const mime = c.req.header('content-type') ?? ''
    const kind = candidateKind(name ?? '', mime)
    if (kind === 'image' || kind === 'text') {
      const bytes = await readBounded(c.req.raw, FILE_LIMITS[kind])
      try { return c.json(saveFileAttachment(state, session, bytes, name, mime)) } catch (error) {
        if (error instanceof RefRefused) throw new HttpError(error.status, error.message)
        if (error instanceof ImageRefused) throw new HttpError(/exceeds|limit|MiB/.test(error.message) ? 413 : 415, error.message)
        throw error
      }
    }
    const staged = await uploads.stageBody(c.req.raw.body)
    if (kind === null && !binaryFileKind(staged.head) && staged.received <= MAX_IMAGE_BYTES) {
      // neither its name nor its type said: an image or a text by its bytes, kept as before
      const bytes = await stagedBytes(staged)
      try { return c.json(saveFileAttachment(state, session, bytes, name, mime)) } catch (error) {
        if (error instanceof RefRefused) throw new HttpError(error.status, error.message)
        if (error instanceof ImageRefused) throw new HttpError(/exceeds|limit|MiB/.test(error.message) ? 413 : 415, error.message)
        throw error
      }
    }
    return c.json(await finishStaged(state, session, staged, name ?? '', mime))
  })

  // a PDF or a video on this machine, by its path: the desktop app's main process only (the token header, never the
  // page's cookie). The harness checks the file itself — a regular file at its own real path, one name, outside what
  // the agent's commands are denied — reads no more than its first bytes, copies and hashes nothing, and records its
  // identity. A refusal is final (the client does not upload the file instead), except one answered with the code
  // `copy_instead`: the file lies where only its path is out of the agent's reach, and the client uploads a copy.
  app.post('/api/sessions/:session_id/attachments/local', async (c) => {
    if (!tokensMatch(c.req.header(HEADER) ?? '', state.session_token)) throw new HttpError(401, `a file is attached by its path only with the ${HEADER} header (the desktop app); the session cookie is not enough`)
    const session = requireSession(state, c.req.param('session_id'))
    const body = await parseBody(c, LocalAttachmentBodySchema)
    const denied = deniedRoots({ data_dir: state.settings.data_dir, projects: repo.listProjects(state.conn), project_id: session.project_id })
    try {
      const inspected = inspectLocalFile(body.path, denied, body.media_type ?? '', { data_dir: state.settings.data_dir })
      const name = cleanName(body.name || inspected.file_name, REF_EXTENSIONS[inspected.fields.media_type] ?? 'bin')
      return c.json(insertLocalRef(state.conn, session.project_id, session.id, name, inspected))
    } catch (error) {
      if (error instanceof RefRefused) throw new HttpError(error.status, error.message, error.code)
      throw error
    }
  })

  // a HEIC photo the person attaches (an iPhone's, sometimes under a .JPG name), made a JPEG before it is uploaded:
  // the composer shows and sends that JPEG — nothing is stored here, and an upload still takes PNG, JPEG and WebP only
  app.post('/api/images/jpeg', async (c) => {
    const bytes = await readBounded(c.req.raw, MAX_HEIF_BYTES)
    try {
      const jpeg = await heifToJpeg(bytes)
      return new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })
    } catch (error) {
      if (error instanceof ImageRefused) throw new HttpError(bytes.length > MAX_HEIF_BYTES ? 413 : 415, error.message)
      throw error
    }
  })

  app.get('/api/sessions/:session_id/attachments/:asset_id', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const attachment = attachmentOf(state, session, c.req.param('asset_id'))
    if (isFileRefAttachment(attachment)) return serveRef(attachment, c.req.header('range'))
    const bytes = readAttachment(state, session, attachment)
    if (!bytes) throw new HttpError(409, 'attachment missing or damaged')
    return new Response(bytes, {
      headers: {
        'content-type': attachment.media_type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable',
        'content-security-policy': "default-src 'none'; sandbox",
        ...('file_kind' in attachment ? { 'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(attachment.name)}` } : {}),
      },
    })
  })

  // a site's icon kept beside a page a run of this project fetched: what the page's source chips wear
  // the icon of a site a link in the session names (a cited page the session did not read): fetched from the site
  // itself and kept, as a read page's is — no icon service is asked; none to give is a 404 (the chip keeps its letter)
  app.get('/api/sessions/:session_id/site-icons/by-host/:host', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const id = await siteIconForHost(state.store, state.conn, session.project_id, c.req.param('host'))
    const asset = id ? repo.getAsset(state.conn, id) : null
    if (!asset) throw new HttpError(404, 'no icon for this site')
    return new Response(state.store.read(asset.storage_path), {
      headers: {
        'content-type': String(asset.meta.media_type ?? 'application/octet-stream'), 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=86400',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    })
  })

  app.get('/api/sessions/:session_id/site-icons/:asset_id', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const asset = repo.getAsset(state.conn, c.req.param('asset_id'))
    if (!asset || asset.project_id !== session.project_id || asset.kind !== 'image' || asset.meta.role !== SITE_ICON_ROLE) throw new HttpError(404, 'no such site icon in this session')
    return new Response(state.store.read(asset.storage_path), {
      headers: {
        'content-type': String(asset.meta.media_type ?? 'application/octet-stream'), 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    })
  })

  return app
}
