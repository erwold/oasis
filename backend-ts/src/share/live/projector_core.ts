/** The live share's projection work, run in the projector worker (projector_worker.ts) — or in process, for tests only
 *  (InlineProjector). It reads through a ShareSource (a READ-ONLY connection of its own in the worker; no runner, no
 *  credential store, no AppState), projects with the snapshot's own code (share/snapshot.ts buildLiveSnapshot: the same
 *  whitelist, sanitizer and sensitive-source rules), validates the result against the strict LiveSnapshotSchema, and
 *  serializes it ONCE; what it hands back is bytes of a checked DTO, its content hash, and the projection's picture map.
 *
 *  Errors never carry their message out (a message may quote content): `gone` (the session was deleted) or `error`. */

import { createHash, createHmac } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { LiveSnapshotSchema, type LiveImageRef, type LiveSnapshot } from '@oasis-code/contract'
import { harnessConfig, ModelConfig } from '../../config.ts'
import { Conn } from '../../db/database.ts'
import * as repo from '../../db/repo.ts'
import { graphOf } from '../../agent/collab.ts'
import { assetAttachment, attachmentReader } from '../../llm/attachments.ts'
import { AssetStore } from '../../store.ts'
import { HttpError, type AppState } from '../../api/state.ts'
import { buildLiveSnapshot, type LiveImageOutcome, type LiveOptions, type LiveRunInput, type ShareSource } from '../snapshot.ts'
import { STRIP_POLICY, stripImage } from './images.ts'
import { buildLivePart, PartTooLarge, serializePart } from './part.ts'

export interface ProjectorInit {
  db_path: string
  assets_dir: string
  data_dir: string
  workspaces_dir: string
  /** the app's session token: for the sanitizer only (masked wherever it appears); never logged */
  session_token: string
  /** the model routes (their dump()), for labels only */
  models: Record<string, unknown>[]
  default_model: string | null
}

export interface ProjectRequest {
  session_id: string
  options: LiveOptions
  /** the producer's random salt: resource ids are HMACs under it (unguessable, stable for the producer's life) */
  salt: string
  runs: LiveRunInput[]
  max_bytes: number
}
export type ProjectReply =
  | { ok: true; hash: string; snapshot: Uint8Array; images: [string, string][]; build_ms: number; truncated_to_fit: boolean }
  | { ok: false; code: 'gone' | 'error' }

/** Live state v2: one session's part (share/live/part.ts), its card's row keys kept by the main thread across builds. */
export interface PartRequest {
  session_id: string
  options: LiveOptions
  salt: string
  runs: LiveRunInput[]
  max_bytes: number
  row_keys: [string, string][]
}
export type PartReply =
  | { ok: true; hash: string; part: Uint8Array; title: string; images: [string, string][]; row_keys: [string, string][]; build_ms: number; truncated_to_fit: boolean }
  /** too_large: the part does not fit its bound even without items or card rows (part.ts PartTooLarge) */
  | { ok: false; code: 'gone' | 'error' | 'too_large' }

/** `protocol: 2`: a v2 part's picture, its resource id bound to its session (resourceOfV2). */
export interface ImageRequest { session_id: string; asset_id: string; resource: string; salt: string; protocol?: 1 | 2 }
export type ImageReply = { ok: true; bytes: Uint8Array; media_type: LiveImageRef['media_type'] } | { ok: false }

/** bytes of stripped pictures kept for the image route */
const IMAGE_CACHE_BYTES = 64 * 1024 * 1024

interface Stripped { bytes: Uint8Array; media_type: LiveImageRef['media_type']; width: number; height: number; digest: string }

export class ProjectorCore {
  private readonly cache = new Map<string, Stripped>()
  private cached = 0

  constructor(private readonly src: ShareSource, private readonly closeSource: () => void = () => {}) {}

  /** The worker's core: a read-only connection of its own and the asset store's reads; the graph from a stand-in of the
   *  runner's handles that names only the watched runs (collab.ts reads `runs.handles` for liveness, nothing else). */
  static open(init: ProjectorInit, watched: () => LiveRunInput[], sessionOf: () => string): ProjectorCore {
    const db = new Database(init.db_path, { readonly: true })
    const conn = new Conn(db, init.db_path)
    conn.exec('PRAGMA busy_timeout=5000')
    conn.exec('PRAGMA query_only=1')
    const store = new AssetStore(init.assets_dir)
    const config = harnessConfig({ models: init.models.map((m) => new ModelConfig(m as ConstructorParameters<typeof ModelConfig>[0])), default_model: init.default_model })
    const shim = (sessionId: string) => ({
      conn, config,
      runs: { handles: new Map(watched().map((r) => [r.run_id, { run_id: r.run_id, session_id: sessionId === sessionOf() ? sessionId : '', done: false }])) },
    }) as unknown as AppState
    const src: ShareSource = {
      conn, config, store, settings: { data_dir: init.data_dir, workspaces_dir: init.workspaces_dir }, session_token: init.session_token,
      graph: (sessionId) => graphOf(shim(sessionId), sessionId),
    }
    return new ProjectorCore(src, () => db.close())
  }

  close(): void {
    this.cache.clear()
    this.cached = 0
    this.closeSource()
  }

  private keep(key: string, s: Stripped): void {
    if (s.bytes.length > IMAGE_CACHE_BYTES / 4) return
    this.cache.delete(key)
    this.cache.set(key, s)
    this.cached += s.bytes.length
    for (const [k, v] of this.cache) {
      if (this.cached <= IMAGE_CACHE_BYTES) break
      this.cache.delete(k)
      this.cached -= v.bytes.length
    }
  }

  private strip(assetId: string, sourceDigest: string, img: { media_type: string; width: number; height: number }, bytes: Uint8Array): Stripped | { omitted: 'damaged' | 'unsupported' } {
    const key = `${STRIP_POLICY}\0${assetId}\0${sourceDigest}`
    const hit = this.cache.get(key)
    if (hit !== undefined) { this.cache.delete(key); this.cache.set(key, hit); return hit }
    const out = stripImage(bytes, img)
    if (!out.ok) return { omitted: out.reason }
    const s: Stripped = { bytes: out.bytes, media_type: out.media_type, width: out.width, height: out.height, digest: createHash('sha256').update(out.bytes).digest('hex') }
    this.keep(key, s)
    return s
  }

  static resourceOf(salt: string, assetId: string, digest: string): string {
    return `m${createHmac('sha256', salt).update(`oasis-code live image v1\0${assetId}\0${digest}`).digest('hex').slice(0, 24)}`
  }

  /** A v2 picture's resource id: bound to its session as well (a resource of one session is never another's). */
  static resourceOfV2(salt: string, sessionId: string, assetId: string, digest: string): string {
    return `m${createHmac('sha256', salt).update(`oasis-code live image v2\0${sessionId}\0${assetId}\0${digest}`).digest('hex').slice(0, 24)}`
  }

  /** Live state v2: one session's part — projected, checked (LiveSessionV2Schema) and serialized once, within its
   *  bound (part.ts serializePart). */
  projectPart(req: PartRequest): PartReply {
    const started = performance.now()
    try {
      const image = (assetId: string, img: { media_type: string; width: number; height: number; sha256?: string }, bytes: Uint8Array): LiveImageOutcome => {
        const digest = img.sha256 ?? createHash('sha256').update(bytes).digest('hex')
        const s = this.strip(assetId, digest, img, bytes)
        if ('omitted' in s) return s
        return { resource: ProjectorCore.resourceOfV2(req.salt, req.session_id, assetId, s.digest), bytes: s.bytes.length, media_type: s.media_type, width: s.width, height: s.height }
      }
      const rowKeys = new Map(req.row_keys)
      const built = buildLivePart(this.src, req.session_id, req.options, { runs: new Map(req.runs.map((r) => [r.run_id, r])), image }, rowKeys)
      const { bytes, hash, truncated } = serializePart(built.part, req.max_bytes)
      return { ok: true, hash, part: bytes, title: built.part.title, images: [...built.images], row_keys: [...rowKeys], build_ms: Math.round(performance.now() - started), truncated_to_fit: truncated }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return { ok: false, code: 'gone' }
      if (error instanceof PartTooLarge) return { ok: false, code: 'too_large' }
      return { ok: false, code: 'error' }
    }
  }

  project(req: ProjectRequest): ProjectReply {
    const started = performance.now()
    try {
      const image = (assetId: string, img: { media_type: string; width: number; height: number; sha256?: string }, bytes: Uint8Array): LiveImageOutcome => {
        const digest = img.sha256 ?? createHash('sha256').update(bytes).digest('hex')
        const s = this.strip(assetId, digest, img, bytes)
        if ('omitted' in s) return s
        return { resource: ProjectorCore.resourceOf(req.salt, assetId, s.digest), bytes: s.bytes.length, media_type: s.media_type, width: s.width, height: s.height }
      }
      const runs = new Map(req.runs.map((r) => [r.run_id, r]))
      const projected = buildLiveSnapshot(this.src, req.session_id, req.options, { runs, image })
      // the strict DTO: a field the contract does not name never leaves; what is serialized is the parsed value
      const checked = LiveSnapshotSchema.parse(projected.snapshot)
      const { bytes, hash, truncated } = serialize(checked, req.max_bytes)
      return { ok: true, hash, snapshot: bytes, images: [...projected.images], build_ms: Math.round(performance.now() - started), truncated_to_fit: truncated }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return { ok: false, code: 'gone' }
      return { ok: false, code: 'error' }
    }
  }

  /** A picture of the session, stripped — only when it is still the session's own attachment image and its resource id
   *  is the one this salt gives it (the caller checked the resource is in the link's current projection). */
  image(req: ImageRequest): ImageReply {
    try {
      const conn = this.src.conn
      const session = repo.getSession(conn, req.session_id)
      if (session === null || session.status === repo.DELETED_SESSION || !/^[A-Za-z0-9_-]{1,128}$/.test(req.asset_id)) return { ok: false }
      const asset = repo.getAsset(conn, req.asset_id)
      if (asset === null || asset.project_id !== session.project_id || asset.meta.session_id !== session.id || asset.meta.role !== 'attachment' || asset.kind !== 'image') return { ok: false }
      const attachment = assetAttachment(asset)
      if ('file_kind' in attachment || 'representation' in attachment) return { ok: false }
      const read = attachmentReader((id) => repo.getAsset(conn, id), (p) => this.src.store.read(p), session.project_id, session.id)
      const bytes = read(attachment)
      if (bytes === null) return { ok: false }
      const s = this.strip(req.asset_id, (attachment as { sha256?: string }).sha256 ?? createHash('sha256').update(bytes).digest('hex'), attachment, bytes)
      if ('omitted' in s) return { ok: false }
      const expected = req.protocol === 2 ? ProjectorCore.resourceOfV2(req.salt, req.session_id, req.asset_id, s.digest) : ProjectorCore.resourceOf(req.salt, req.asset_id, s.digest)
      if (expected !== req.resource) return { ok: false }
      return { ok: true, bytes: s.bytes.slice(), media_type: s.media_type }
    } catch {
      return { ok: false }
    }
  }
}

const encoder = new TextEncoder()

/** The checked snapshot as UTF-8 JSON, once; its hash over everything but `generated_at` (a state that only got older
 *  is not a new revision). Past `max` bytes the latest items are dropped until it fits (items_truncated says so). */
export function serialize(snapshot: LiveSnapshot, max: number): { bytes: Uint8Array; hash: string; truncated: boolean } {
  const encode = (s: LiveSnapshot) => {
    // generated_at is the third key (after format and version): the first `"generated_at":""` is the snapshot's own
    const bare = JSON.stringify({ ...s, generated_at: '' })
    const hash = createHash('sha256').update(bare).digest('hex')
    const bytes = encoder.encode(bare.replace('"generated_at":""', `"generated_at":${JSON.stringify(s.generated_at)}`))
    return { bytes, hash }
  }
  const first = encode(snapshot)
  if (first.bytes.length <= max) return { ...first, truncated: false }
  let lo = 0
  let hi = snapshot.items.length
  let best: { bytes: Uint8Array; hash: string } | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const out = encode({ ...snapshot, items: snapshot.items.slice(0, mid), stats: { ...snapshot.stats, items_truncated: true } })
    if (out.bytes.length <= max) { best = out; lo = mid + 1 } else hi = mid - 1
  }
  if (best === null) throw new Error('the live state does not fit its bound even without items')
  return { ...best, truncated: true }
}
