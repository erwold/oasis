/** PDF and video references (`ref-v1`, docs/large-file-attachments.md): what the harness knows of such a file without
 *  reading it, and the few reads it ever makes of one.
 *
 *  - Naming a file is a bounded look at its first REF_HEAD_BYTES (the signature) — never a whole read or a hash.
 *  - A local file (the person's own, registered by the desktop app) is checked where it stands: a regular file of one
 *    name, at its own real path, outside what the agent's commands are denied; its identity (device, inode, size,
 *    times) is recorded by the harness itself. Nothing is copied.
 *  - An upload is written once, hashed as it streams, and moved by a rename into the store under its content hash.
 *  - The bytes of a reference are read only when a route takes the file natively, bounded by its recorded size,
 *    through O_NOFOLLOW and against its recorded identity (a local file) or hash (an upload); a file that changed is
 *    refused — other bytes never stand in for what was attached. Reads are cached for the hydration's lifetime.
 *  - A reference whose bytes do not travel is its one fixed note (refFileNote): no read, no hash, no stat. */

import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statfsSync, statSync, type BigIntStats } from 'node:fs'
import { open as openAsync, type FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  APP_REQUEST_CAP_BYTES, FileFingerprintSchema, FileRefAttachmentSchema, REF_ASSET_KIND, REF_REPRESENTATION, refKindOf,
  type Asset, type FileFingerprint, type FileRefAttachment, type Project,
} from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { CREDENTIAL_READ_DENY, expandUser } from '../execution/isolation.ts'
import {
  AttachmentAccessRefused, identityOf, inspectLocalSource, isSealed, readLocalBounded, sealStoredFile, storedUpload, unsealStoredFile,
  type LocalAccessOptions, type LocalSource,
} from '../workspace/attachment_access.ts'
import type { AssetStore } from '../store.ts'

/** How much of a file's start the harness reads to name it. */
export const REF_HEAD_BYTES = 64 * 1024
/** Asset.meta.role of an attachment (as api/attachments.ts names it). */
const ATTACHMENT_ROLE = 'attachment'

/** A reference refused for what it is or where it stands; `status` is the HTTP answer. */
export class RefRefused extends Error {
  /** code: `copy_instead` when the file may still be attached as a copy (an upload), just not by its path */
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); this.name = 'RefRefused' }
}

/** The bytes of a reference cannot be had as they were attached (gone, changed, or not this session's). */
export class RefUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'RefUnavailable' }
}

// ---- naming a file by its first bytes ---------------------------------------------------------------------------

const ascii = (b: Uint8Array, start: number, end: number): string => Buffer.from(b.subarray(start, Math.min(end, b.length))).toString('latin1')
const startsWith = (b: Uint8Array, bytes: number[], at = 0): boolean => b.length >= at + bytes.length && bytes.every((n, i) => b[at + i] === n)

/** What a file is by its first bytes: a PDF or a video container, with the media type its signature says, or null.
 *  A container check only — no track, codec or page is looked at. */
export function refHeadKind(head: Uint8Array): { file_kind: 'pdf' | 'video'; media_type: string } | null {
  if (ascii(head, 0, 1024).includes('%PDF-')) return { file_kind: 'pdf', media_type: 'application/pdf' }
  const box = ascii(head, 4, 8)
  if (box === 'ftyp' && head.length >= 12) {
    const brand = ascii(head, 8, 12)
    if (['M4A ', 'M4B ', 'M4P '].includes(brand)) return null // audio-only MPEG-4
    if (brand === 'qt  ') return { file_kind: 'video', media_type: 'video/quicktime' }
    if (brand.startsWith('3gp') || brand.startsWith('3g2')) return { file_kind: 'video', media_type: 'video/3gpp' }
    return { file_kind: 'video', media_type: 'video/mp4' }
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(box)) return { file_kind: 'video', media_type: 'video/quicktime' }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { file_kind: 'video', media_type: ascii(head, 0, 4096).includes('webm') ? 'video/webm' : 'video/x-matroska' }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'AVI ') return { file_kind: 'video', media_type: 'video/x-msvideo' }
  if (startsWith(head, [0, 0, 1, 0xba]) || startsWith(head, [0, 0, 1, 0xb3])) return { file_kind: 'video', media_type: 'video/mpeg' }
  if ((head[0] === 0x47 && head.length > 188 && head[188] === 0x47) || (head[4] === 0x47 && head.length > 196 && head[196] === 0x47)) return { file_kind: 'video', media_type: 'video/mp2t' }
  if (startsWith(head, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return { file_kind: 'video', media_type: 'video/x-ms-wmv' }
  if (ascii(head, 0, 3) === 'FLV' && head[3] === 1) return { file_kind: 'video', media_type: 'video/x-flv' }
  if (ascii(head, 0, 4) === 'OggS') return { file_kind: 'video', media_type: 'video/ogg' }
  return null
}

/** A file as a reference names it: its first bytes decide; a name that says the other kind is a conflict, refused.
 *  Ogg (audio as often as video) is taken only under a video's name. */
export function classifyRef(name: string, head: Uint8Array, declared = ''): { file_kind: 'pdf' | 'video'; media_type: string } {
  const byName = refKindOf(name, declared)
  const byHead = refHeadKind(head)
  if (!byHead) throw new RefRefused(415, `${JSON.stringify(name)} is not a PDF or a video by its first bytes`)
  if (byName && byName.file_kind !== byHead.file_kind) throw new RefRefused(415, `${JSON.stringify(name)} is named as a ${byName.file_kind} but its bytes are a ${byHead.file_kind}`)
  if (byHead.media_type === 'video/ogg' && byName?.file_kind !== 'video') throw new RefRefused(415, `${JSON.stringify(name)}: an Ogg file is taken only under a video's name (.ogv)`)
  return byHead
}

// ---- the identity of a local file --------------------------------------------------------------------------------

export function fingerprintOf(st: BigIntStats): FileFingerprint {
  return { dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtime_ns: String(st.mtimeNs), ctime_ns: String(st.ctimeNs) }
}
const sameFingerprint = (a: FileFingerprint, b: FileFingerprint): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime_ns === b.mtime_ns && a.ctime_ns === b.ctime_ns

/** Paths compared as the volume compares them (macOS volumes fold case by default). */
const fold = (p: string): string => (process.platform === 'darwin' ? p.normalize('NFD').toLowerCase() : p)
const under = (path: string, root: string): boolean => {
  const p = fold(path), r = fold(root).replace(/\/+$/, '')
  return r !== '' && (p === r || p.startsWith(r + '/'))
}
const realOr = (path: string): string => { try { return realpathSync.native(path) } catch { return path } }

/** Where the agent's commands are denied (workspace/sandbox.ts), and so no local reference may stand: the credential
 *  stores on the fixed list, the harness's data directory, and this project's original folder when it is a snapshot
 *  (its commands work on the copy). Other projects' folders are readable, as they are to a command. `copy`: a file
 *  there may still be attached as a copy — the person picked it, and only the path is out of the agent's reach; a
 *  credential store or the data directory never (a copy would hand the agent what its box denies). */
export function deniedRoots(o: { data_dir: string; projects: readonly Pick<Project, 'id' | 'kind' | 'source_path'>[]; project_id: string; extra?: readonly string[] }): { root: string; why: string; copy: boolean }[] {
  const out: { root: string; why: string; copy: boolean }[] = []
  for (const p of CREDENTIAL_READ_DENY) out.push({ root: realOr(expandUser(p)), why: 'a credential store', copy: false })
  out.push({ root: realOr(o.data_dir), why: "the harness's data directory", copy: false })
  for (const extra of o.extra ?? []) out.push({ root: realOr(extra), why: 'a location the harness denies', copy: false })
  const own = o.projects.find((p) => p.id === o.project_id)
  if (own?.source_path && own.kind === 'snapshot') out.push({ root: realOr(own.source_path), why: "this project's original folder (its agents work on the copy)", copy: true })
  return out
}

/** A local file checked for a reference, nothing of it read but its first REF_HEAD_BYTES. The path is taken as the
 *  file it names: a link, or a folder reached through a link (or another spelling of a folder on a case-folding
 *  volume), is resolved to the file's canonical real path — the same canonical path the desktop app forwards — and
 *  everything is judged there: absolute, printable, a regular file (a directory, a FIFO or a device refused without
 *  being opened for reading or waited on), of one name (no other hard-linked name), outside the denied roots — by
 *  spelling and by the identity of every folder above it (workspace/attachment_access.ts inspectLocalSource), so a link
 *  into the data directory or a credential store is refused like the place itself. Its identity is the harness's own,
 *  taken on the open descriptor; the head is read only from that same inode (readLocalBounded). Status: 422 not a
 *  file, or not a PDF or a video by its head and name; 403 a denied place or a second name; 409 changed meanwhile. */
export function inspectLocalFile(path: unknown, denied: readonly { root: string; why: string; copy?: boolean }[], declared = '', o: { data_dir: string }): { fields: Omit<FileRefAttachment, 'asset_id' | 'name'>; fingerprint: FileFingerprint; file_name: string } {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new RefRefused(422, 'the path must be absolute')
  if (/[\x00-\x1f\x7f]/.test(path)) throw new RefRefused(422, 'the path holds control characters')
  try { lstatSync(path) } catch (error) { throw new RefRefused(422, `no file at ${JSON.stringify(path)} (${(error as NodeJS.ErrnoException).code ?? 'unreadable'})`) }
  // the canonical path of what it names (a link followed to its end; a folder's own spelling)
  let real: string
  try { real = realpathSync.native(path) } catch (error) { throw new RefRefused(422, `${JSON.stringify(path)} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? 'error'})`) }
  let st: BigIntStats
  try { st = lstatSync(real, { bigint: true }) } catch (error) { throw new RefRefused(422, `no file at ${JSON.stringify(real)} (${(error as NodeJS.ErrnoException).code ?? 'unreadable'})`) }
  if (!st.isFile()) throw new RefRefused(422, `${JSON.stringify(path)} is not a regular file`)
  // every denied place it lies in is named; a copy is offered only when each of them allows one
  const within = denied.filter((d) => under(real, d.root))
  if (within.length) {
    const copy = within.every((d) => d.copy === true)
    throw new RefRefused(403, `${JSON.stringify(path)} is in ${within.map((d) => d.why).join(' and ')}, where the agent's commands cannot read; ${copy ? 'it is attached as a copy instead' : 'it is not attached'}`, copy ? 'copy_instead' : null)
  }
  if (st.nlink > 1n) throw new RefRefused(403, `${JSON.stringify(path)} has other names (hard links); it is not attached by path`)
  const access = { data_dir: o.data_dir, deny_roots: denied.map((d) => d.root) }
  let source: LocalSource
  let head: Uint8Array
  try {
    source = inspectLocalSource(real, access)
    if (source.real_path !== real) throw new AttachmentAccessRefused(`${real} moved while it was checked`)
    head = readLocalBounded(source, REF_HEAD_BYTES, access)
  } catch (error) {
    if (!(error instanceof AttachmentAccessRefused)) throw error
    if (/ is under /.test(error.message)) throw new RefRefused(403, `${JSON.stringify(path)}: ${error.message}`)
    if (/names; the harness does not read a file with an alias/.test(error.message)) throw new RefRefused(403, `${JSON.stringify(path)} has other names (hard links); it is not attached by path`)
    if (/not a regular file/.test(error.message)) throw new RefRefused(422, `${JSON.stringify(path)} is not a regular file`)
    throw new RefRefused(409, `${JSON.stringify(path)} changed while it was being checked; attach it again (${error.message})`)
  }
  let kind: { file_kind: 'pdf' | 'video'; media_type: string }
  // a local file that is not a PDF or a video by its head and name is not a file this route registers: 422 (the
  // contract's status for the local route; an upload's body answers 415)
  try { kind = classifyRef(basename(real), head, declared) } catch (error) {
    if (error instanceof RefRefused) throw new RefRefused(422, error.message)
    throw error
  }
  const id = source.identity
  return {
    fields: { media_type: kind.media_type, bytes: Number(id.size), file_kind: kind.file_kind, representation: REF_REPRESENTATION, origin: 'local', location: real, sha256: null },
    fingerprint: { dev: id.dev, ino: id.ino, size: id.size, mtime_ns: id.mtime_ns, ctime_ns: id.ctime_ns }, file_name: basename(real),
  }
}

// ---- the asset rows ----------------------------------------------------------------------------------------------

/** The frozen reference an asset row holds, or null when the row is no well-formed reference. */
export function refFromAsset(asset: Asset): FileRefAttachment | null {
  if (asset.kind !== REF_ASSET_KIND) return null
  const parsed = FileRefAttachmentSchema.safeParse({ ...(asset.meta.ref as Record<string, unknown> | undefined), asset_id: asset.id })
  return parsed.success ? parsed.data : null
}

/** A local file's reference made a session's attachment (no store file: storage_path and sha256 empty). */
export function insertLocalRef(conn: Conn, projectId: string, sessionId: string, name: string, inspected: ReturnType<typeof inspectLocalFile>): FileRefAttachment {
  const ref = { name, ...inspected.fields }
  const asset = repo.insertAsset(conn, projectId, REF_ASSET_KIND, '', ref.bytes, '', { role: ATTACHMENT_ROLE, session_id: sessionId, ref, fingerprint: inspected.fingerprint })
  return refFromAsset(asset)!
}

export const REF_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi', 'video/mpeg': 'mpg', 'video/3gpp': '3gp', 'video/x-ms-wmv': 'wmv', 'video/x-flv': 'flv', 'video/mp2t': 'm2ts', 'video/ogg': 'ogv',
}
/** Every frozen field of a reference (what a history piece and its asset row must agree on). */
export const REF_FIELDS = ['asset_id', 'name', 'media_type', 'bytes', 'file_kind', 'representation', 'origin', 'location', 'sha256'] as const satisfies readonly (keyof FileRefAttachment)[]
const UPLOAD_PATH = /^[^./\\]+\/ref\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/

/** An upload's place in the store, under its content hash: `<project>/ref/<sha256>.<ext>`. */
export function refUploadRel(projectId: string, sha256: string, mediaType: string): string {
  return `${projectId}/ref/${sha256}.${REF_EXTENSIONS[mediaType] ?? 'bin'}`
}

/** Whether stored uploads are sealed on this platform (the macOS user-immutable flag); elsewhere nothing is sealed,
 *  no identity is recorded, and no command is ever granted an upload (attachment_access.authorizeInputFiles). */
export const SEALS_UPLOADS = process.platform === 'darwin'

/** A stored upload removed by the harness itself (a rollback; any future removal of the store's files goes this way):
 *  the store's own file only — a regular file of one name strictly inside the real store, reached through no link —
 *  its seal lifted first. Fails closed: when that check or the unseal fails, nothing is removed and why is returned
 *  (null: removed). Never a person's local file. */
export function removeStoredUpload(path: string, scope: { data_dir: string; store_root: string }): string | null {
  try {
    storedUpload(path, scope)
    if (SEALS_UPLOADS && isSealed(path)) unsealStoredFile(path, scope)
  } catch (error) {
    return `${path} was left in place: ${(error as Error).message}`
  }
  rmSync(path, { force: true })
  return null
}

/** The staged file of a finished upload moved into the store (a rename on the same volume: never a copy; the same
 *  bytes already there are kept and the staged file removed) and made the session's attachment. On macOS the file is
 *  sealed at its final name (user-immutable, one name, read back from the file) and its identity recorded with the
 *  asset before the asset exists: a command is granted it only as that sealed inode. The same content already stored
 *  is the same sealed file: its identity is taken as it stands (sealing it again would move its ctime and void the
 *  earlier references' grants). A seal that cannot be set fails the upload (nothing is published, the file it made is
 *  removed): an upload is never granted unsealed, and never silently kept as if it were. Elsewhere nothing is sealed
 *  and no identity recorded — the reference works for the model and the download; commands are not granted it. */
export function insertUploadRef(conn: Conn, store: AssetStore, dataDir: string, projectId: string, sessionId: string, staged: string,
  info: { name: string; media_type: string; file_kind: 'pdf' | 'video'; bytes: number; sha256: string }): FileRefAttachment {
  const rel = refUploadRel(projectId, info.sha256, info.media_type)
  const root = realpathSync.native(store.root)
  const final = join(root, rel)
  const scope = { data_dir: dataDir, store_root: root }
  mkdirSync(join(root, projectId, 'ref'), { recursive: true })
  let kept = false
  try { const st = lstatSync(final); kept = st.isFile() && st.size === info.bytes } catch { kept = false }
  let made = false
  if (kept) rmSync(staged, { force: true })
  else {
    try { renameSync(staged, final) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new RefRefused(500, 'the upload area and the store are on different volumes; nothing was copied')
      throw error
    }
    made = true
  }
  let fingerprint: FileFingerprint | null = null
  if (SEALS_UPLOADS) {
    try {
      if (kept && isSealed(final)) {
        const st = statSync(final, { bigint: true })
        if (!st.isFile() || st.nlink !== 1n) throw new AttachmentAccessRefused(`${final} has ${st.nlink} names; a file with an alias is never granted`)
        fingerprint = identityOf(st)
      } else fingerprint = sealStoredFile(final, scope).identity
    } catch (error) {
      const left = made ? removeStoredUpload(final, scope) : null
      throw new RefRefused(500, `the upload could not be sealed in the store, so it was not published: ${(error as Error).message}${left ? `; ${left}` : ''}`)
    }
  }
  const ref = { name: info.name, media_type: info.media_type, bytes: info.bytes, file_kind: info.file_kind, representation: REF_REPRESENTATION, origin: 'upload' as const, location: final, sha256: info.sha256 }
  try {
    const asset = repo.insertAsset(conn, projectId, REF_ASSET_KIND, info.sha256, info.bytes, rel, { role: ATTACHMENT_ROLE, session_id: sessionId, ref, ...(fingerprint ? { fingerprint } : {}) })
    return refFromAsset(asset)!
  } catch (error) {
    const left = made ? removeStoredUpload(final, scope) : null
    if (left) console.error(`the upload's rollback did not remove its stored file: ${left}`)
    throw error
  }
}

/** The asset row of a reference as this session holds it, every frozen field equal — or why not. The database only:
 *  no file is touched. */
export function recordedRef(asset: Asset | null, ref: FileRefAttachment, project: string, session: string, storeRoot: string): string | null {
  if (!asset || asset.project_id !== project || asset.kind !== REF_ASSET_KIND || asset.meta.role !== ATTACHMENT_ROLE || asset.meta.session_id !== session) return `attachment ${ref.asset_id} is not this session's`
  const frozen = refFromAsset(asset)
  if (!frozen) return `attachment ${ref.asset_id} has an invalid record`
  for (const key of REF_FIELDS) {
    if (frozen[key] !== ref[key]) return `attachment ${ref.asset_id} does not match its record (${key})`
  }
  if (frozen.origin === 'local') {
    if (asset.storage_path !== '' || !FileFingerprintSchema.safeParse(asset.meta.fingerprint).success) return `attachment ${ref.asset_id} has an invalid record`
  } else {
    const rel = asset.storage_path.replace(/\\/g, '/')
    if (!UPLOAD_PATH.test(rel) || !rel.startsWith(`${project}/ref/`) || asset.sha256 !== frozen.sha256 || join(storeRoot, rel) !== frozen.location) return `attachment ${ref.asset_id} has an invalid record`
  }
  return null
}

// ---- the bytes of a native reference -----------------------------------------------------------------------------

/** What hydration and the preflight need of the session's references. */
export interface RefAccess {
  /** why the reference is not this session's as recorded (the database only), or null */
  check(ref: FileRefAttachment): string | null
  /** why its bytes could not be read as attached now (opens it, compares identity; reads nothing), or null */
  verify(ref: FileRefAttachment): string | null
  /** its bytes, bounded by its size, as attached (RefUnavailable otherwise); cached */
  read(ref: FileRefAttachment): Uint8Array
  /** how many times a file's content was read (tests: a path-only reference is never read) */
  readonly reads: number
}

/** The session's references, read only through it. `cache_bytes` bounds what it keeps between requests (a request
 *  never carries more than the largest provider bound, so neither does the cache). A cached file is keyed by every
 *  frozen field of its reference, and its record is checked against the database on every request; a local file is
 *  checked on every request too — opened without following a link, its full identity (device, inode, size, times) and
 *  its single name compared on that descriptor, every folder above it outside the denied roots (`local`: the data
 *  directory and the caller's denied roots) — so a hit never stands for a file replaced, moved or reached through a
 *  folder swapped since. */
export function refAccess(o: { lookup: (id: string) => Asset | null; store: AssetStore; project: string; session: string; cache_bytes?: number; local: LocalAccessOptions }): RefAccess {
  const cap = o.cache_bytes ?? APP_REQUEST_CAP_BYTES
  const cache = new Map<string, Buffer>()
  let held = 0
  let reads = 0
  let storeRoot: string | null = null
  const root = (): string => (storeRoot ??= realOr(o.store.root))
  const keyOf = (ref: FileRefAttachment): string => JSON.stringify(REF_FIELDS.map((k) => ref[k]))
  const record = (ref: FileRefAttachment): Asset => {
    const asset = o.lookup(ref.asset_id)
    const why = recordedRef(asset, ref, o.project, o.session, root())
    if (why) throw new RefUnavailable(why)
    return asset!
  }
  const changed = (ref: FileRefAttachment, detail: string): RefUnavailable => new RefUnavailable(
    `the attached file ${JSON.stringify(ref.name)} at ${JSON.stringify(ref.location)} ${detail}; other bytes are not sent in its place. `
    + 'This route takes the file itself, so the conversation cannot go on here with it: choose a route that is given its path instead, or start a new conversation and attach the file again.')
  /** a local file as it was attached: its frozen path and the identity the harness recorded */
  const localSource = (ref: FileRefAttachment, asset: Asset): LocalSource => {
    const fp = FileFingerprintSchema.parse(asset.meta.fingerprint)
    return { real_path: ref.location, identity: { dev: fp.dev, ino: fp.ino, size: fp.size, mtime_ns: fp.mtime_ns, ctime_ns: fp.ctime_ns }, nlink: 1 }
  }
  /** up to `limit` bytes of a local file (0: its checks alone), through the security helper; refusals said plainly */
  const readLocal = (ref: FileRefAttachment, asset: Asset, limit: number, whole: boolean): Uint8Array => {
    try { return readLocalBounded(localSource(ref, asset), limit, { ...o.local, whole }) } catch (error) {
      if (!(error instanceof AttachmentAccessRefused)) throw error
      const m = error.message
      const detail = /cannot be opened|is a link now/.test(m) ? 'cannot be opened' : / is under /.test(m) ? 'is now under a place the harness never reads' : 'changed or was replaced since it was attached'
      throw changed(ref, `${detail} (${m})`)
    }
  }
  /** an upload opened without following a link, a regular file of its stored size; the caller closes it */
  const openUpload = (ref: FileRefAttachment): number => {
    let fd: number
    try { fd = openSync(ref.location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
      throw changed(ref, `cannot be opened (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
    }
    try {
      const st = fstatSync(fd, { bigint: true })
      if (!st.isFile()) throw changed(ref, 'is no longer a regular file')
      if (st.size !== BigInt(ref.bytes)) throw changed(ref, 'is not the size it was stored at')
      return fd
    } catch (error) { closeSync(fd); throw error }
  }
  const remember = (key: string, bytes: Buffer): void => {
    if (bytes.length > cap) return
    while (held + bytes.length > cap && cache.size) {
      const [first, kept] = cache.entries().next().value as [string, Buffer]
      cache.delete(first)
      held -= kept.length
    }
    cache.set(key, bytes)
    held += bytes.length
  }
  return {
    get reads() { return reads },
    check(ref) {
      try { record(ref); return null } catch (error) { return (error as Error).message }
    },
    verify(ref) {
      try {
        const asset = record(ref)
        if (ref.origin === 'local') readLocal(ref, asset, 0, false)
        else closeSync(openUpload(ref))
        return null
      } catch (error) { return (error as Error).message }
    },
    read(ref) {
      const asset = record(ref)
      const key = keyOf(ref)
      const hit = cache.get(key)
      if (hit) {
        // a local file is checked on every request (its metadata only, on a descriptor); an upload is sealed
        if (ref.origin === 'local') readLocal(ref, asset, 0, false)
        cache.delete(key)
        cache.set(key, hit)
        return hit
      }
      if (ref.bytes > cap) throw changed(ref, `is larger than one request may carry (${cap} bytes)`)
      let bytes: Buffer
      if (ref.origin === 'local') {
        const got = readLocal(ref, asset, ref.bytes, true)
        reads += 1
        if (got.length !== ref.bytes) throw changed(ref, 'is not the size it was attached at')
        bytes = Buffer.from(got.buffer, got.byteOffset, got.byteLength)
      } else {
        const fd = openUpload(ref)
        try {
          reads += 1
          bytes = Buffer.allocUnsafe(ref.bytes)
          let got = 0
          while (got < bytes.length) {
            const n = readSync(fd, bytes, got, bytes.length - got, got)
            if (n <= 0) break
            got += n
          }
          if (got !== ref.bytes || readSync(fd, Buffer.alloc(1), 0, 1, got) !== 0) throw changed(ref, 'is not the size it was attached at')
          if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw changed(ref, 'does not hold the bytes that were uploaded')
        } finally { closeSync(fd) }
      }
      remember(key, bytes)
      return bytes
    },
  }
}

// ---- a staged upload ---------------------------------------------------------------------------------------------

/** A staged upload whose bytes and hash no longer agree (a chunk that could not be rolled back): dropped, not resumed. */
export class StagedUploadBroken extends Error {
  constructor(message: string, readonly cause_error?: unknown) { super(message); this.name = 'StagedUploadBroken' }
}

/** A body reader told to stop, its cancel neither awaited nor allowed to throw. */
function stopReader(reader: { cancel(): Promise<void> } | null): void {
  if (!reader) return
  try { void reader.cancel().catch(() => undefined) } catch { /* released or gone */ }
}

/** An upload being written: one file in the staging folder, written once at increasing offsets, its hash updated as
 *  the bytes arrive (the reader's pace is the writer's: a chunk is read only once the last one is written). A failed
 *  or interrupted chunk is rolled back — the file truncated and the hash restored to where the chunk began — so a
 *  retry at the same offset continues it exactly. */
export class StagedUpload {
  received = 0
  head: Buffer = Buffer.alloc(0)
  /** why the file and its hash parted (a rollback that failed): the upload is to be dropped */
  broken: string | null = null
  /** the body being read now (cancel() stops it) */
  private reader: { cancel(): Promise<void> } | null = null
  private cancelled = false
  private hash = createHash('sha256')
  private constructor(readonly path: string, private handle: FileHandle | null) {}

  static async create(dir: string, id: string): Promise<StagedUpload> {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${id}.part`)
    const handle = await openAsync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    return new StagedUpload(path, handle)
  }

  /** Append a body's bytes: at most `maxChunk` of them, never beyond `size` in all (RefRefused 413, the chunk
   *  rolled back). Returns the bytes taken. */
  async append(body: ReadableStream<Uint8Array> | null, maxChunk: number, size: number): Promise<number> {
    const handle = this.handle
    if (!handle) throw new Error('the upload is closed')
    const start = this.received
    const before = this.hash.copy()
    const headBefore = this.head
    let n = 0
    if (this.broken) throw new StagedUploadBroken(this.broken)
    if (this.cancelled) throw new StagedUploadBroken('the upload was cancelled')
    const reader = body?.getReader() ?? null
    this.reader = reader
    try {
      if (reader) {
        for (;;) {
          const chunk = await reader.read()
          if (this.cancelled) throw new StagedUploadBroken('the upload was cancelled while a chunk arrived')
          if (chunk.done) break
          const value = chunk.value
          if (n + value.length > maxChunk) throw new RefRefused(413, `a chunk is at most ${maxChunk} bytes`)
          if (start + n + value.length > size) throw new RefRefused(413, `more bytes than the ${size} the upload was started with`)
          for (let done = 0; done < value.length;) {
            const { bytesWritten } = await handle.write(value, done, value.length - done, start + n + done)
            if (!(bytesWritten > 0)) throw Object.assign(new Error('short write with no progress'), { code: 'EIO' })
            done += bytesWritten
          }
          this.hash.update(value)
          if (this.head.length < REF_HEAD_BYTES) this.head = Buffer.concat([this.head, Buffer.from(value.subarray(0, REF_HEAD_BYTES - this.head.length))])
          n += value.length
        }
      }
    } catch (error) {
      // the body told to stop, not waited on: a client's stream may never settle its cancel, and the rollback below
      // must not hang behind it
      stopReader(reader)
      try { await handle.truncate(start) } catch (truncateError) {
        // the file could not be put back where the chunk began: its bytes and the hash no longer agree, so the upload
        // cannot continue — it is broken (the caller drops it), never resumed over bytes that are not the hash's
        this.broken = `the chunk could not be rolled back (${(truncateError as NodeJS.ErrnoException).code ?? (truncateError as Error).message})`
        throw new StagedUploadBroken(this.broken, error)
      }
      this.hash = before
      this.head = headBefore
      throw error
    } finally {
      this.reader = null
      try { reader?.releaseLock() } catch { /* released */ }
    }
    this.received = start + n
    return n
  }

  /** The bytes written to the disk and the file closed; their sha256. */
  async finish(): Promise<string> {
    const handle = this.handle
    if (!handle) throw new Error('the upload is closed')
    if (this.broken) throw new StagedUploadBroken(this.broken)
    // closed whatever the sync answers: no descriptor outlives the upload
    this.handle = null
    try { await handle.sync() } finally { await handle.close() }
    return this.hash.digest('hex')
  }

  /** Stop the chunk being read now, if any (its append rolls back and throws). Returns at once: the body's own cancel
   *  is not waited on (a pending read ends as the stream closes; its source's cancel may never settle). */
  cancel(): void {
    this.cancelled = true
    stopReader(this.reader)
  }

  /** Closed and removed. */
  async discard(): Promise<void> {
    const handle = this.handle
    this.handle = null
    if (handle) await handle.close().catch(() => undefined)
    rmSync(this.path, { force: true })
  }
}

/** The staging folder emptied: what an earlier life of the harness left half uploaded is not kept. */
export function clearStaging(dir: string): void {
  if (existsSync(dir)) {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) rmSync(dir, { force: true })
    else rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** Bytes free where the staging folder is (null when the volume does not say). */
export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch { return null }
}
