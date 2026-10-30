/** A PDF or a video with no file of this computer behind it (a browser, a file made in the page), uploaded in chunks
 *  of the size the harness names (`chunk_bytes`: a chunk's size, never a bound on the file). Each chunk is a slice of
 *  the File handed to fetch as it is: the browser reads it from disk as it sends — the page never holds the file
 *  (no arrayBuffer, text, FileReader or stream of it). An interruption goes on from where the harness says it got
 *  (`received`); an offset the harness disagrees with is asked again, never guessed; an upload the harness no longer
 *  knows (it restarted, it cleaned up) is said so, and a send again starts it over. */

import { UploadReceivedSchema, UploadStartSchema, UploadStatusSchema } from '@oasis-code/contract'

/** What the harness answers for an upload it opened (UploadStart). */
export interface UploadSession { upload_id: string; chunk_bytes: number; received: number }

/** The harness's upload endpoints for one session (api/client.ts), each refusing with an error carrying `status`.
 *  What they answer is checked here against the contract (UploadStart, UploadReceived, UploadStatus,
 *  `{deleted: true}`), never taken on trust. */
export interface ChunkApi {
  create: (body: { name: string; size: number; type: string }, signal?: AbortSignal) => Promise<unknown>
  put: (uploadId: string, offset: number, chunk: Blob, signal?: AbortSignal) => Promise<unknown>
  status: (uploadId: string, signal?: AbortSignal) => Promise<unknown>
  complete: (uploadId: string, signal?: AbortSignal) => Promise<unknown>
  cancel: (uploadId: string) => Promise<unknown>
}

/** Why an upload stopped: `gone` (the harness no longer holds it, or holds something this file is not — start over),
 *  `cancelled` (the person stopped it; `dropped` says whether the harness confirmed it let go of what arrived),
 *  `refused` (the harness said no to the file), `interrupted` (the network or the harness failed — a send again goes
 *  on from `received`). */
export class ChunkedUploadError extends Error {
  readonly kind: 'gone' | 'cancelled' | 'refused' | 'interrupted'
  readonly received: number
  /** a cancel only: the harness confirmed it dropped the upload (or holds none). false: it may still hold it — the
   *  upload is kept with the file, so that removing the file asks again. */
  readonly dropped: boolean
  constructor(kind: ChunkedUploadError['kind'], message: string, received: number, dropped = kind !== 'cancelled') {
    super(message)
    this.name = 'ChunkedUploadError'
    this.kind = kind
    this.received = received
    this.dropped = dropped
  }
}

const statusOf = (error: unknown): number | null => {
  const s = (error as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : null
}
const reasonOf = (error: unknown): string => {
  const e = error as { detail?: unknown; message?: unknown } | null
  return typeof e?.detail === 'string' ? e.detail : typeof e?.message === 'string' ? e.message : String(error)
}
/** a failure worth asking again: the network (no status), a timeout, a conflict of the moment (409: the harness is
 *  busy with the upload), too many requests, the harness's own failure */
const transient = (status: number | null): boolean => status === null || status === 408 || status === 409 || status === 429 || status >= 500
const backoff = (attempt: number) => 250 * 2 ** attempt
const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const usableChunk = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0

/** What asking the harness to drop an upload came to: `dropped` only when it said so (`{deleted: true}`) or said it
 *  holds no such upload (404/410); otherwise why not. */
export interface DropOutcome { dropped: boolean; reason: string | null }

/** Asks the harness to drop an upload and what arrived of it (DELETE), again after a moment while the failure is of
 *  the moment (the network, a 5xx, a 409 of the moment), at most `retries` times more. The harness stops a chunk being
 *  written itself before it drops the upload; a 409 that says `completed` is final (the upload became an attachment).
 *  Never says dropped unless the harness did. */
export async function dropUpload(api: Pick<ChunkApi, 'cancel'>, uploadId: string, opts: { retries?: number; wait?: (ms: number) => Promise<void> } = {}): Promise<DropOutcome> {
  const retries = opts.retries ?? 3
  const wait = opts.wait ?? defaultWait
  for (let attempt = 0; ; attempt++) {
    let reason: string
    let again: boolean
    try {
      const answer = await api.cancel(uploadId)
      if ((answer as { deleted?: unknown } | null)?.deleted === true) return { dropped: true, reason: null }
      reason = 'the harness did not say it dropped the upload'
      again = false
    } catch (error) {
      const status = statusOf(error)
      if (status === 404 || status === 410) return { dropped: true, reason: null }    // it holds nothing of it
      reason = reasonOf(error)
      // a completed upload is not undone (its attachment stays until a message leaves it out): said, never asked again
      again = transient(status) && (error as { body?: { completed?: unknown } | null } | null)?.body?.completed !== true
    }
    if (!again || attempt >= retries) return { dropped: false, reason }
    await wait(backoff(attempt))
  }
}

export interface ChunkedOptions {
  /** the upload a send before began and did not finish (in this session): asked where it got, then gone on with */
  resume?: { upload_id: string; chunk_bytes: number } | null
  signal?: AbortSignal
  /** the upload the harness opened: kept with the file so a send again goes on with it */
  onStart?: (session: { upload_id: string; chunk_bytes: number }) => void
  /** how many bytes the harness holds, of how many */
  onProgress?: (sent: number, total: number) => void
  /** transient failures (the network, a 5xx) in a row before the upload stops as interrupted; also how many times a
   *  cancel asks the harness again to drop the upload */
  retries?: number
  wait?: (ms: number) => Promise<void>
}

/** Uploads `file` in chunks and answers what the harness made of it (the reference; the caller checks it). */
export async function uploadInChunks(file: Blob, meta: { name: string; type: string }, api: ChunkApi, opts: ChunkedOptions = {}): Promise<unknown> {
  const total = file.size
  const { signal, onProgress, retries = 3 } = opts
  const wait = opts.wait ?? defaultWait
  let uploadId: string | null = null
  let chunk = 0
  let received = 0
  // the most the harness can hold of this file by now: what it said it held when this upload was opened or resumed,
  // and the end of every chunk sent since — a count past it names bytes never sent, and is never gone on from
  let sentUpTo = 0
  const cancelled = async (): Promise<never> => {
    const drop = uploadId ? await dropUpload(api, uploadId, { retries, wait }) : { dropped: true, reason: null }
    throw new ChunkedUploadError('cancelled', drop.dropped ? 'upload cancelled'
      : `upload cancelled, but the harness did not confirm it dropped what arrived (${drop.reason}); remove the file to ask it again`, received, drop.dropped)
  }
  const gone = () => new ChunkedUploadError('gone', 'the harness no longer holds this upload (it restarted or cleaned it up); send again to start it over', received)
  const cannotGoOn = (why: string) => new ChunkedUploadError('gone', `${why}: this upload cannot go on; send again to start it over`, received)
  /** where the harness got, as it says (UploadStatus) — of this upload, of a file this size, never past what was sent */
  const where = async (id: string): Promise<number> => {
    const parsed = UploadStatusSchema.safeParse(await api.status(id, signal))
    if (!parsed.success) throw cannotGoOn('the harness answered no usable upload status')
    const at = parsed.data
    if (at.upload_id !== id || at.size !== total) throw cannotGoOn(`the harness holds ${at.upload_id} of ${at.size} bytes, not this file of ${total}`)
    if (at.received > total || at.received > sentUpTo) throw cannotGoOn(`the harness says it holds ${at.received} bytes of ${total}, ${at.received > total ? 'past the file' : `more than the ${sentUpTo} sent`}`)
    return at.received
  }
  const resume = opts.resume && typeof opts.resume.upload_id === 'string' && opts.resume.upload_id && usableChunk(opts.resume.chunk_bytes) ? opts.resume : null
  if (resume) {
    uploadId = resume.upload_id                               // a cancel while it is asked drops this one
    try {
      sentUpTo = total                                        // a send before may have sent any of it
      received = await where(resume.upload_id)
      sentUpTo = received
      chunk = resume.chunk_bytes
    } catch (error) {
      if (signal?.aborted) return cancelled()
      if (error instanceof ChunkedUploadError) throw error
      const status = statusOf(error)
      if (status !== 404 && status !== 410) throw new ChunkedUploadError('interrupted', `the harness did not say where the upload got: ${reasonOf(error)}`, received)
      uploadId = null                                         // gone: start over
      received = 0
    }
  }
  if (!uploadId) {
    let answer: unknown
    try { answer = await api.create({ name: meta.name, size: total, type: meta.type }, signal) } catch (error) {
      if (signal?.aborted) return cancelled()
      const status = statusOf(error)
      throw new ChunkedUploadError(status !== null && status >= 400 && status < 500 ? 'refused' : 'interrupted', reasonOf(error), 0)
    }
    const parsed = UploadStartSchema.safeParse(answer)
    if (!parsed.success || !parsed.data.upload_id) throw new ChunkedUploadError('refused', 'the harness answered no usable upload', 0)
    uploadId = parsed.data.upload_id
    chunk = parsed.data.chunk_bytes
    received = 0
    sentUpTo = 0
    opts.onStart?.({ upload_id: uploadId, chunk_bytes: chunk })
  }
  onProgress?.(received, total)
  let failures = 0
  while (received < total) {
    if (signal?.aborted) return cancelled()
    const end = Math.min(total, received + chunk)
    let failure: unknown
    let conflict: boolean
    try {
      sentUpTo = Math.max(sentUpTo, end)
      const answer = UploadReceivedSchema.safeParse(await api.put(uploadId, received, file.slice(received, end), signal))
      // the harness writes a chunk whole: it holds exactly up to the chunk's end, or it is asked where it got
      if (answer.success && answer.data.received === end) {
        received = end
        failures = 0
        onProgress?.(received, total)
        continue
      }
      failure = new Error(`the harness answered ${answer.success ? `${answer.data.received} bytes` : 'no byte count'} for the chunk ${received}–${end}`)
      conflict = true
    } catch (error) {
      if (signal?.aborted) return cancelled()
      const status = statusOf(error)
      if (status === 404 || status === 410) throw gone()
      if (!transient(status)) throw new ChunkedUploadError('refused', reasonOf(error), received)
      failure = error
      conflict = status === 409
    }
    failures += 1
    if (failures > retries) {
      throw new ChunkedUploadError('interrupted', `upload interrupted at ${received} of ${total} bytes (${reasonOf(failure)}); send again to go on from there`, received)
    }
    if (!conflict) await wait(backoff(failures - 1))
    if (signal?.aborted) return cancelled()
    // where the harness got is its word, asked again — never this page's guess, and never past what was sent
    try { received = await where(uploadId) } catch (again) {
      if (signal?.aborted) return cancelled()
      if (again instanceof ChunkedUploadError) throw again
      const s = statusOf(again)
      if (s === 404 || s === 410) throw gone()
      if (conflict) throw new ChunkedUploadError('interrupted', `the harness disagreed on the offset and did not say where it got: ${reasonOf(again)}`, received)
    }
    onProgress?.(received, total)
  }
  if (signal?.aborted) return cancelled()
  try { return await api.complete(uploadId, signal) } catch (error) {
    if (signal?.aborted) return cancelled()
    const status = statusOf(error)
    if (status === 404 || status === 410) throw gone()
    throw new ChunkedUploadError(status !== null && status >= 400 && status < 500 ? 'refused' : 'interrupted', reasonOf(error), received)
  }
}
