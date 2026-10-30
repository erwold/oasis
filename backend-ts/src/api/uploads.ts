/** The chunked upload of a PDF or a video (docs/large-file-attachments.md): what a browser holds without a path. The
 *  file is written once into the staging folder as its chunks arrive — each at the exact offset the last one ended,
 *  hashed as it goes, read only as fast as it is written — and on completion moved by a rename into the store as a
 *  `ref-v1` upload reference. One chunk is at most UPLOAD_CHUNK_BYTES (the transport's unit, which keeps each request
 *  under the server's body bound — not a limit on the file). A chunk and the completion of one upload take turns (the
 *  other answers 409 with `received`); a cancel stops a chunk being written (its bytes rolled back), waits for it, and
 *  drops the upload. A completion's answer is kept for a while (UPLOAD_COMPLETED_TTL_MS): a client that lost it asks
 *  again — GET says `completed`, POST …/complete answers the same reference — and never sends gigabytes twice. The
 *  state lives in this process: after a restart the staging folder is emptied and an old upload id is a 404 (the
 *  client starts again); an upload left idle is dropped. */

import { Hono, type Context } from 'hono'
import { MiB, UPLOAD_CHUNK_BYTES, UploadStartBodySchema, refKindOf, type FileRefAttachment, type Session } from '@oasis-code/contract'
import { newId } from '../ids.ts'
import { classifyRef, clearStaging, freeBytes, insertUploadRef, REF_EXTENSIONS, RefRefused, StagedUpload, StagedUploadBroken } from '../llm/ref_files.ts'
import { HttpError, parseBody, type Api } from './common.ts'
import { requireSession, type AppState } from './state.ts'
import { join } from 'node:path'

/** An upload left this long without a chunk is dropped (its staged bytes removed). */
export const UPLOAD_IDLE_MS = 6 * 3600_000
/** How long a completed upload's answer is kept for a client that lost it (the same reference again, nothing stored). */
export const UPLOAD_COMPLETED_TTL_MS = 30 * 60_000
/** How long a cancel waits for the chunk it stopped to roll back before it drops the upload anyway. */
export const UPLOAD_CANCEL_WAIT_MS = 10_000
/** Room kept free on the volume beyond the file an upload announces. */
export const UPLOAD_FREE_RESERVE_BYTES = 64 * MiB
/** Uploads one session may have open at once. */
export const MAX_OPEN_UPLOADS_PER_SESSION = 16

interface Entry {
  id: string
  session_id: string
  project_id: string
  name: string
  type: string
  size: number
  staged: StagedUpload
  /** a chunk or the completion under way (the other waits its turn: 409); a cancel stops and awaits it */
  active: Promise<unknown> | null
  /** what the active operation is */
  doing: 'chunk' | 'complete' | null
  /** a cancel was asked: nothing more is taken */
  cancelling: boolean
  /** the cancel's work — the stopped chunk settled, then the upload dropped — once begun; every cancel (a repeated
   *  DELETE, the harness closing) waits on this same one, bounded. The entry stays open until it is done. */
  cleanup: Promise<FileRefAttachment | null> | null
  touched: number
}

/** A completed upload's answer, kept a while for the same session. */
interface Completed { session_id: string; size: number; attachment: FileRefAttachment; at: number }

/** A label for the person and the model, never a path: the last segment, printable, bounded. */
export function cleanName(raw: string | undefined | null, ext: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._ -]/gu, '').trim()
  const suffix = /\.[a-zA-Z0-9]{1,12}$/.exec(base)?.[0] ?? ''
  return (base.length <= 120 ? base : base.slice(0, 120 - suffix.length) + suffix) || `attachment.${ext}`
}

/** A cancel whose stopped chunk had not settled within the bound: nothing is said dropped yet. The upload stays
 *  cancelling (no chunk or completion is taken) and is dropped when that chunk settles — never while it may still
 *  write — so a DELETE asked again answers the outcome. */
export class UploadCancelPending extends Error {
  constructor(readonly received: number) { super('the upload is being cancelled; the chunk under way has not stopped yet, so nothing is dropped yet — ask again'); this.name = 'UploadCancelPending' }
}

/** A disk that filled under a write. */
const isNoSpace = (error: unknown): boolean => ['ENOSPC', 'EDQUOT'].includes(String((error as NodeJS.ErrnoException)?.code ?? ''))

/** A start asked of uploads that are closing (the harness shutting down). */
const closingError = () => new HttpError(503, 'the harness is closing; start the upload again once it is back')

export class Uploads {
  readonly dir: string
  private readonly entries = new Map<string, Entry>()
  private readonly completed = new Map<string, Completed>()
  /** Starts still making their staged file, by upload id: each holds its place in its session's quota from the
   *  moment it is counted (no await between the count and this reservation) until it is an entry or has failed. */
  private readonly starting = new Map<string, { session_id: string; done: Promise<unknown> }>()
  /** close() was called: no start is taken, and one still making its file removes it. */
  private closed = false

  /** `cancelWaitMs`: how long a cancel waits for its work (tests set it short). */
  constructor(dataDir: string, private readonly now: () => number = Date.now, private readonly cancelWaitMs: number = UPLOAD_CANCEL_WAIT_MS) {
    this.dir = join(dataDir, 'uploads')
    // what an earlier life of the harness left half uploaded is not kept
    clearStaging(this.dir)
  }

  /** How many uploads are open (tests). */
  get open(): number { return this.entries.size }

  /** Uploads idle past UPLOAD_IDLE_MS dropped; completions past their time forgotten. */
  async sweep(): Promise<void> {
    const before = this.now() - UPLOAD_IDLE_MS
    for (const e of [...this.entries.values()]) if (e.active === null && e.cleanup === null && e.touched < before) await this.drop(e)
    const done = this.now() - UPLOAD_COMPLETED_TTL_MS
    for (const [id, c] of [...this.completed]) if (c.at < done) this.completed.delete(id)
  }

  async start(session: Session, body: { name: string; size: number; type: string }): Promise<Entry> {
    if (this.closed) throw closingError()
    await this.sweep()
    if (this.closed) throw closingError()
    if (!refKindOf(body.name, body.type)) throw new HttpError(415, `${JSON.stringify(body.name)} is not a PDF or a video by its name or type; images and text go to POST /api/sessions/:id/attachments`)
    // the open uploads and the starts still making their file, counted and reserved with no await between
    const held = [...this.entries.values(), ...this.starting.values()].filter((e) => e.session_id === session.id).length
    if (held >= MAX_OPEN_UPLOADS_PER_SESSION) throw new HttpError(429, `this session has ${MAX_OPEN_UPLOADS_PER_SESSION} uploads open; finish or cancel one first`)
    const free = freeBytes(this.dir)
    if (free !== null && free < body.size + UPLOAD_FREE_RESERVE_BYTES) throw new HttpError(507, `not enough free disk space for ${body.size} bytes (${free} free)`)
    const id = newId('up')
    // reserved before make() begins, so its release (in make's finally) always comes after
    const reservation: { session_id: string; done: Promise<unknown> } = { session_id: session.id, done: Promise.resolve() }
    this.starting.set(id, reservation)
    const made = this.make(session, id, body)
    reservation.done = made.catch(() => undefined)
    return made
  }

  /** A reserved start's staged file made and the upload opened. The reservation is released whatever happens (a file
   *  that could not be made holds no place), and a file made after close() began is removed, never left open. */
  private async make(session: Session, id: string, body: { name: string; size: number; type: string }): Promise<Entry> {
    try {
      const staged = await StagedUpload.create(this.dir, id)
      if (this.closed) {
        await staged.discard()
        throw closingError()
      }
      const entry: Entry = {
        id, session_id: session.id, project_id: session.project_id, name: body.name, type: body.type, size: body.size,
        staged, active: null, doing: null, cancelling: false, cleanup: null, touched: this.now(),
      }
      this.entries.set(id, entry)
      return entry
    } finally { this.starting.delete(id) }
  }

  /** The session's open upload, or null (a completed one is `completedOf`). */
  find(session: Session, id: string): Entry | null {
    const entry = this.entries.get(id)
    return entry && entry.session_id === session.id ? entry : null
  }

  get(session: Session, id: string): Entry {
    const entry = this.find(session, id)
    if (!entry) throw new HttpError(404, `no upload ${id} in this session (an upload does not outlive a restart of the harness: start it again)`)
    return entry
  }

  /** The kept answer of the session's completed upload, while it is kept. */
  completedOf(session: Session, id: string): Completed | null {
    const c = this.completed.get(id)
    if (!c || c.session_id !== session.id) return null
    if (c.at < this.now() - UPLOAD_COMPLETED_TTL_MS) { this.completed.delete(id); return null }
    return c
  }

  remember(entry: Entry, attachment: FileRefAttachment): void {
    this.completed.set(entry.id, { session_id: entry.session_id, size: entry.size, attachment, at: this.now() })
  }

  /** Run one chunk or the completion as the upload's turn: the others answer busy until it settles. */
  async turn<T>(entry: Entry, doing: 'chunk' | 'complete', work: () => Promise<T>): Promise<T> {
    const run = work()
    entry.active = run
    entry.doing = doing
    try { return await run } finally {
      if (entry.active === run) { entry.active = null; entry.doing = null }
      entry.touched = this.now()
    }
  }

  /** Stop what the upload is doing (a chunk being read is cancelled and rolled back; a completion is let finish), wait
   *  for it and drop the upload. Returns what the completion made, if one finished meanwhile. The whole of it — the
   *  stop, the chunk settling, the drop — is bounded by the cancel wait: past it, UploadCancelPending (nothing is said
   *  dropped; the drop happens once the chunk settles, never beside a write still under way). */
  async cancel(entry: Entry): Promise<FileRefAttachment | null> {
    entry.cancelling = true
    entry.cleanup ??= this.settleAndDrop(entry)
    const pending = Symbol('pending')
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const outcome = await Promise.race([entry.cleanup, new Promise<typeof pending>((r) => { timer = setTimeout(() => r(pending), this.cancelWaitMs) })])
      if (outcome === pending) throw new UploadCancelPending(entry.staged.received)
      return outcome
    } finally { if (timer) clearTimeout(timer) }
  }

  /** The cancel's work: the chunk under way told to stop (without waiting on its body's own cancel, which a client may
   *  never settle), awaited until it has rolled back or failed, then the upload dropped — or the completion that won
   *  answered. */
  private async settleAndDrop(entry: Entry): Promise<FileRefAttachment | null> {
    const active = entry.active
    if (active !== null) {
      if (entry.doing === 'chunk') entry.staged.cancel()
      await active.catch(() => undefined)
    }
    const done = this.completed.get(entry.id)
    if (done && done.session_id === entry.session_id) {
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
      return done.attachment
    }
    await this.drop(entry)
    return null
  }

  /** The upload's staged file closed and removed and the upload forgotten. Only when nothing is writing to it: the
   *  callers are a chunk's or completion's own failure path (inside its turn), the idle sweep (no turn, no cancel), and
   *  a cancel's work (after the turn settled). */
  async drop(entry: Entry): Promise<void> {
    entry.staged.cancel()
    await entry.staged.discard()
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
  }

  /** Every open upload dropped (the harness is closing: a chunk being written is stopped, nothing half written is kept,
   *  no file left open). */
  async close(): Promise<void> {
    // each cancel bounded; one whose chunk has not stopped is left to drop itself when it settles (never closed under a
    // write) — the staging folder is emptied at the next start in any case. Starts still making their file are waited
    // for first: each removes its file once made (closed), so none becomes an upload this close never saw.
    this.closed = true
    await Promise.all([...this.starting.values()].map((s) => s.done))
    for (const e of [...this.entries.values()]) {
      try { await this.cancel(e) } catch (error) {
        if (!(error instanceof UploadCancelPending)) console.error(`upload ${e.id}: cancel at close failed: ${(error as Error).message}`)
      }
    }
    this.completed.clear()
  }

  /** One request's body taken whole as an upload (the original POST …/attachments for a PDF or a video). */
  async stageBody(body: ReadableStream<Uint8Array> | null): Promise<StagedUpload> {
    const staged = await StagedUpload.create(this.dir, newId('up'))
    try {
      await staged.append(body, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      return staged
    } catch (error) {
      await staged.discard()
      if (isNoSpace(error)) throw new HttpError(507, 'the disk filled while the file was written; nothing was kept')
      throw error
    }
  }
}

const registry = new WeakMap<AppState, Uploads>()
/** The app's uploads (made, and the staging folder emptied, when the routes are built at startup). */
export function uploadsOf(state: AppState): Uploads {
  let uploads = registry.get(state)
  if (!uploads) { uploads = new Uploads(state.settings.data_dir); registry.set(state, uploads) }
  return uploads
}

/** The app's uploads closed, when it closes. */
export async function closeUploads(state: AppState): Promise<void> {
  await registry.get(state)?.close()
  registry.delete(state)
}

/** A staged file made the session's reference: its first bytes name it (they must agree with its name), its hash is
 *  the one taken as it was written, and it is renamed into the store (and sealed there). The staged file is removed
 *  on any refusal. */
export async function finishStaged(state: Pick<AppState, 'conn' | 'store' | 'settings'>, session: Session, staged: StagedUpload, name: string, declared: string): Promise<FileRefAttachment> {
  let kind
  try { kind = classifyRef(name, staged.head, declared) } catch (error) {
    await staged.discard()
    if (error instanceof RefRefused) throw new HttpError(error.status, error.message)
    throw error
  }
  const bytes = staged.received
  try {
    const sha256 = await staged.finish()
    return insertUploadRef(state.conn, state.store, state.settings.data_dir, session.project_id, session.id, staged.path,
      { name: cleanName(name, REF_EXTENSIONS[kind.media_type] ?? 'bin'), media_type: kind.media_type, file_kind: kind.file_kind, bytes, sha256 })
  } catch (error) {
    await staged.discard()
    if (error instanceof RefRefused) throw new HttpError(error.status, error.message)
    throw error
  }
}

export function uploadRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api
  const uploads = uploadsOf(state)
  const busy = (c: Context, entry: Entry) => c.json({ detail: `the ${entry.doing === 'complete' ? 'completion' : 'chunk before'} of this upload is under way; try again`, received: entry.staged.received }, 409)

  app.post('/api/sessions/:session_id/uploads', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const body = await parseBody(c, UploadStartBodySchema)
    const entry = await uploads.start(session, body)
    return c.json({ upload_id: entry.id, chunk_bytes: UPLOAD_CHUNK_BYTES, received: 0 })
  })

  app.get('/api/sessions/:session_id/uploads/:upload_id', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const id = c.req.param('upload_id')
    const done = uploads.completedOf(session, id)
    if (done) return c.json({ upload_id: id, received: done.size, size: done.size, completed: true })
    const entry = uploads.get(session, id)
    return c.json({ upload_id: entry.id, received: entry.staged.received, size: entry.size })
  })

  app.put('/api/sessions/:session_id/uploads/:upload_id', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const id = c.req.param('upload_id')
    const done = uploads.completedOf(session, id)
    if (done) { await c.req.raw.body?.cancel(); return c.json({ detail: 'the upload is complete', received: done.size, completed: true }, 409) }
    const entry = uploads.get(session, id)
    const offset = Number(c.req.query('offset'))
    if (!Number.isSafeInteger(offset) || offset < 0) { await c.req.raw.body?.cancel(); throw new HttpError(422, 'offset (a whole number of bytes) is required') }
    if (entry.active !== null || entry.cancelling) { await c.req.raw.body?.cancel(); return busy(c, entry) }
    if (offset !== entry.staged.received) { await c.req.raw.body?.cancel(); return c.json({ detail: `the upload has ${entry.staged.received} bytes; send the chunk at that offset`, received: entry.staged.received }, 409) }
    const declared = Number(c.req.header('content-length') ?? NaN)
    if (Number.isFinite(declared) && (declared > UPLOAD_CHUNK_BYTES || offset + declared > entry.size)) {
      await c.req.raw.body?.cancel()
      throw new HttpError(413, declared > UPLOAD_CHUNK_BYTES ? `a chunk is at most ${UPLOAD_CHUNK_BYTES} bytes` : `more bytes than the ${entry.size} the upload was started with`)
    }
    try {
      await uploads.turn(entry, 'chunk', () => entry.staged.append(c.req.raw.body, UPLOAD_CHUNK_BYTES, entry.size))
    } catch (error) {
      if (isNoSpace(error)) { await uploads.drop(entry); throw new HttpError(507, 'the disk filled while the chunk was written; the upload was dropped') }
      if (error instanceof StagedUploadBroken) {
        // cancelled meanwhile (the cancel drops it), or a chunk that could not be rolled back: dropped, never resumed
        if (!entry.cancelling) await uploads.drop(entry)
        throw new HttpError(410, `${error.message}; the upload was dropped — start it again`)
      }
      if (error instanceof RefRefused) throw new HttpError(error.status, error.message)
      throw error
    }
    return c.json({ received: entry.staged.received })
  })

  app.post('/api/sessions/:session_id/uploads/:upload_id/complete', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const id = c.req.param('upload_id')
    // asked again after it was made (its answer lost on the way): the same reference, nothing new stored
    const done = uploads.completedOf(session, id)
    if (done) return c.json(done.attachment)
    const entry = uploads.get(session, id)
    if (entry.active !== null || entry.cancelling) return busy(c, entry)
    if (entry.staged.received !== entry.size) return c.json({ detail: `${entry.staged.received} of ${entry.size} bytes arrived`, received: entry.staged.received }, 409)
    try {
      // remembered inside the turn: a cancel waiting on it sees the completion, never drops what was made
      const attachment = await uploads.turn(entry, 'complete', async () => {
        const made = await finishStaged(state, session, entry.staged, entry.name, entry.type)
        uploads.remember(entry, made)
        return made
      })
      return c.json(attachment)
    } finally {
      // finished or refused, the upload is over (a refusal removed the staged file)
      await uploads.drop(entry)
    }
  })

  app.delete('/api/sessions/:session_id/uploads/:upload_id', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const id = c.req.param('upload_id')
    const done = uploads.completedOf(session, id)
    if (done) return c.json({ detail: 'the upload is complete: its attachment stays until it is sent or left out of a message', completed: true }, 409)
    const entry = uploads.get(session, id)
    // a chunk being written is stopped and rolled back first (a completion is let finish), then the upload dropped
    let made: FileRefAttachment | null
    try { made = await uploads.cancel(entry) } catch (error) {
      if (error instanceof UploadCancelPending) return c.json({ detail: error.message, deleted: false, cleanup_pending: true, received: error.received }, 503)
      throw error
    }
    if (made) return c.json({ detail: 'the upload completed before it could be cancelled', completed: true }, 409)
    return c.json({ deleted: true })
  })

  return app
}
