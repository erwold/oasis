/** The exact files a session's commands read beyond their sandbox's own rules: its upload references (`ref-v1`,
 *  origin `upload`, kept in the harness's store, which the sandbox denies as a whole) that the person attached to a
 *  message actually sent in this session — a run's, a relay's or an interaction's — each checked against its asset
 *  row (this project, this session, the attachment role, every frozen field, a store path of the reference layout
 *  under the store's real root). Nothing else of the store, no folder, no other session's file.
 *
 *  A local reference needs no grant: the person's file stands where the sandbox already reads it, or not (its
 *  registration refused the places it denies).
 *
 *  The records found here go to workspace/attachment_access.ts authorizeInputFiles, which checks each file on disk
 *  (sealed, one name, its recorded identity) and brands the grant; sandboxForWorkspace takes nothing else and renders
 *  one literal read-only rule per file. What is refused there stays denied, and the command says so. */

import { realpathSync } from 'node:fs'
import { AttachmentSchema, FileFingerprintSchema, isFileRefAttachment, type FileRefAttachment, type Session } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { recordedRef, REF_FIELDS } from '../llm/ref_files.ts'
import type { AssetStore } from '../store.ts'
import { authorizeInputFiles, type AuthorizedInputFiles, type StoredInputRecord } from '../workspace/attachment_access.ts'

/** One file a command of the session may read: the reference it stands for and its absolute real path. */
export interface AttachmentReadGrant { asset_id: string; path: string }

const SENT_ATTACHMENTS = [
  'SELECT attachments_json AS a FROM runs WHERE session_id = ?',
  'SELECT attachments_json AS a FROM relays WHERE session_id = ?',
  'SELECT attachments_json AS a FROM interactions WHERE session_id = ?',
]

/** The upload references exactly as they were frozen on the messages the session sent (runs, relays, interactions),
 *  by asset id — every copy of each, as sent. The grant is judged against these, never rebuilt from the asset row. */
function sentUploadRefs(conn: Conn, sessionId: string): Map<string, FileRefAttachment[]> {
  const byId = new Map<string, FileRefAttachment[]>()
  for (const sql of SENT_ATTACHMENTS) {
    for (const row of conn.all(sql, [sessionId]) as { a: string | null }[]) {
      let list: unknown
      try { list = JSON.parse(row.a ?? '[]') } catch { continue }
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const parsed = AttachmentSchema.safeParse(item)
        if (!parsed.success || !isFileRefAttachment(parsed.data) || parsed.data.origin !== 'upload') continue
        const copies = byId.get(parsed.data.asset_id) ?? []
        copies.push(parsed.data)
        byId.set(parsed.data.asset_id, copies)
      }
    }
  }
  return new Map([...byId].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
}

type SentUpload = { asset: NonNullable<ReturnType<typeof repo.getAsset>>; path: string }

/** The session's sent upload references: each frozen reference as sent compared, field by field, with its asset row
 *  (recordedRef: this project and session, the attachment role, every frozen field, the store path of the reference
 *  layout under the store's real root). The path granted is the sent reference's location, which that check has
 *  just found equal to the row's; a row changed since the message was sent (its location, its name, any field), or
 *  copies of one asset sent with different fields, grant nothing and say why. The database only. */
function sentUploads(conn: Conn, store: Pick<AssetStore, 'root'>, session: Pick<Session, 'id' | 'project_id'>): { granted: SentUpload[]; refused: { asset_id: string; reason: string }[] } {
  const granted: SentUpload[] = []
  const refused: { asset_id: string; reason: string }[] = []
  const sent = sentUploadRefs(conn, session.id)
  let root: string
  try { root = realpathSync.native(store.root) } catch {
    for (const id of sent.keys()) refused.push({ asset_id: id, reason: 'the asset store cannot be resolved' })
    return { granted, refused }
  }
  for (const [id, copies] of sent) {
    const first = copies[0]!
    const differing = copies.find((c) => REF_FIELDS.some((k) => c[k] !== first[k]))
    if (differing) { refused.push({ asset_id: id, reason: `attachment ${id} was sent with differing references; nothing is granted for it` }); continue }
    const asset = repo.getAsset(conn, id)
    const why = recordedRef(asset, first, session.project_id, session.id, root)
    if (why !== null) { refused.push({ asset_id: id, reason: `${why}: the reference as sent no longer agrees with the harness's record; nothing is granted for it` }); continue }
    granted.push({ asset: asset!, path: first.location })
  }
  return { granted, refused }
}

/** The session's upload references that were sent with a message, as read grants (sorted, each once). */
export function sessionAttachmentReads(conn: Conn, store: Pick<AssetStore, 'root'>, session: Pick<Session, 'id' | 'project_id'>): AttachmentReadGrant[] {
  return sentUploads(conn, store, session).granted.map(({ asset, path }) => ({ asset_id: asset.id, path }))
}

/** The records of granted sent uploads, as authorizeInputFiles takes them: the identity is the one recorded when the
 *  store sealed the file (its asset's fingerprint, decimal strings), or null (never granted). */
function inputRecordsOf(granted: readonly SentUpload[]): StoredInputRecord[] {
  return granted.map(({ asset }) => {
    const fp = FileFingerprintSchema.safeParse(asset.meta.fingerprint)
    return {
      asset_id: asset.id, project_id: asset.project_id, session_id: String(asset.meta.session_id ?? ''), role: String(asset.meta.role ?? ''),
      origin: 'upload', storage_path: asset.storage_path.replace(/\\/g, '/'), bytes: asset.byte_size,
      identity: fp.success ? { dev: fp.data.dev, ino: fp.data.ino, size: fp.data.size, mtime_ns: fp.data.mtime_ns, ctime_ns: fp.data.ctime_ns } : null,
    }
  })
}

/** The records the harness holds of the session's sent uploads that agree with the references as sent. */
export function sessionInputRecords(conn: Conn, store: Pick<AssetStore, 'root'>, session: Pick<Session, 'id' | 'project_id'>): StoredInputRecord[] {
  return inputRecordsOf(sentUploads(conn, store, session).granted)
}

/** The session's sent uploads its commands may read now, authorized against the harness's own data directory and store
 *  (each file checked on disk: sealed, of one name, still the identity recorded). Refusals — a reference as sent that
 *  no longer agrees with its record, and whatever the on-disk check refused — are in `refused`; the caller shows them. */
export function sessionInputFiles(conn: Conn, store: Pick<AssetStore, 'root'>, dataDir: string, session: Pick<Session, 'id' | 'project_id'>): AuthorizedInputFiles {
  const { granted, refused } = sentUploads(conn, store, session)
  return authorizeInputFiles({ data_dir: dataDir, store_root: store.root, session: { id: session.id, project_id: session.project_id }, records: inputRecordsOf(granted), refused })
}
