import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChunkedUploadError, dropUpload, uploadInChunks, type ChunkApi } from '../src/state/chunkedUpload.ts'

const MiB = 1024 ** 2
const GiB = 1024 ** 3

/** A file of any size the way a File is: a size and slices — reading it whole throws (the uploader never may). */
class HugeFile {
  readonly size: number
  readonly start: number
  constructor(size: number, start = 0) { this.size = size; this.start = start }
  slice(a: number, b: number) { return new HugeFile(Math.min(b, this.size) - a, this.start + a) }
  arrayBuffer(): never { throw new Error('arrayBuffer of the whole file') }
  text(): never { throw new Error('text of the whole file') }
  stream(): never { throw new Error('stream of the whole file') }
  bytes(): never { throw new Error('bytes of the whole file') }
}
const asBlob = (f: HugeFile) => f as unknown as Blob

/** The harness's upload endpoints, scripted: chunks it holds, failures it is told to answer. `size`: the file a resumed
 *  upload holds (a new one takes the size it is opened with); `answer`: what a PUT answers instead of the count. */
function harness(opts: { chunk?: number; size?: number; fail?: (call: { offset: number; n: number }) => unknown; status?: (received: number) => number | Error | Record<string, unknown>;
  answer?: (call: { offset: number; received: number; n: number }) => unknown; complete?: () => unknown; cancel?: (n: number) => unknown } = {}) {
  const chunk = opts.chunk ?? 32 * MiB
  const log: string[] = []
  const puts: { offset: number; start: number; size: number }[] = []
  let received = 0
  let size = opts.size ?? 0
  let n = 0
  let cancels = 0
  const api: ChunkApi = {
    create: async (body) => { log.push(`create ${body.name} ${body.size} ${body.type}`); size = body.size; return { upload_id: 'u_1', chunk_bytes: chunk, received: 0 } },
    put: async (_id, offset, body) => {
      n += 1
      const failure = opts.fail?.({ offset, n })
      if (failure) throw failure
      const piece = body as unknown as HugeFile
      puts.push({ offset, start: piece.start, size: piece.size })
      assert.equal(offset, received, 'a chunk at the offset the harness holds')
      assert.ok(piece.size <= chunk, 'a chunk no larger than chunk_bytes')
      received += piece.size
      return opts.answer ? opts.answer({ offset, received, n }) : { received }
    },
    status: async (id) => {
      log.push('status')
      const s = opts.status ? opts.status(received) : received
      if (s instanceof Error) throw s
      if (typeof s !== 'number') return s
      received = s
      return { upload_id: id, received, size }
    },
    complete: async () => { log.push('complete'); return opts.complete ? opts.complete() : { asset_id: 'a_1', representation: 'ref-v1' } },
    cancel: async () => { cancels += 1; log.push('cancel'); if (opts.cancel) { const r = opts.cancel(cancels); if (r instanceof Error) throw r; return r } return { deleted: true } },
  }
  return { api, log, puts, get received() { return received } }
}
const status = (code: number, detail = `HTTP ${code}`) => Object.assign(new Error(`${code}: ${detail}`), { status: code, detail })
const noWait = async () => undefined

test('a 7 GiB file goes as slices of the File, chunk after chunk, never read whole; progress ends at its size', async () => {
  const file = new HugeFile(7 * GiB + 123)
  const h = harness()
  const progress: number[] = []
  const answer = await uploadInChunks(asBlob(file), { name: 'film.mov', type: 'video/quicktime' }, h.api, { onProgress: (sent, total) => { assert.equal(total, file.size); progress.push(sent) } })
  assert.deepEqual(answer, { asset_id: 'a_1', representation: 'ref-v1' })
  assert.equal(h.puts.length, Math.ceil(file.size / (32 * MiB)))
  assert.deepEqual(h.puts.map((p) => p.start), h.puts.map((p) => p.offset))        // each body is the slice at its offset
  assert.equal(h.puts.reduce((s, p) => s + p.size, 0), file.size)
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b))
  assert.equal(progress.at(-1), file.size)
  assert.deepEqual(h.log, [`create film.mov ${file.size} video/quicktime`, 'complete'])
})

test('a failure goes on from where the harness says it got: a 503, a dropped connection whose chunk did arrive', async () => {
  const h = harness({ chunk: 4 * MiB, fail: ({ n }) => (n === 2 ? status(503) : n === 4 ? new TypeError('Failed to fetch') : null) })
  const waits: number[] = []
  await uploadInChunks(asBlob(new HugeFile(10 * MiB)), { name: 'a.mp4', type: 'video/mp4' }, h.api, { wait: async (ms) => { waits.push(ms) } })
  assert.deepEqual(h.puts.map((p) => p.offset), [0, 4 * MiB, 8 * MiB])
  assert.deepEqual(waits, [250, 250])
  assert.deepEqual(h.log.filter((l) => l === 'status').length, 2)
  // the chunk sent but its answer lost: the harness holds it, so it is not sent again
  let delivered = false
  const lost = harness({ chunk: 4 * MiB, fail: ({ offset }) => { if (offset === 4 * MiB && !delivered) { delivered = true; return new TypeError('network') } return null }, status: (r) => (delivered && r === 4 * MiB ? 8 * MiB : r) })
  await uploadInChunks(asBlob(new HugeFile(10 * MiB)), { name: 'a.mp4', type: 'video/mp4' }, lost.api, { wait: noWait })
  assert.deepEqual(lost.puts.map((p) => p.offset), [0, 8 * MiB])
})

test('an offset the harness disagrees with (409) is asked again, never guessed; an answer past the file is refused', async () => {
  let conflicted = false
  const h = harness({ chunk: 4 * MiB, fail: ({ offset }) => { if (offset === 4 * MiB && !conflicted) { conflicted = true; return status(409, 'offset 4194304 is not 8388608') } return null }, status: (r) => (conflicted && r === 4 * MiB ? 8 * MiB : r) })
  await uploadInChunks(asBlob(new HugeFile(9 * MiB)), { name: 'a.pdf', type: 'application/pdf' }, h.api, { wait: async () => assert.fail('no wait on a conflict') })
  assert.deepEqual(h.puts.map((p) => p.offset), [0, 8 * MiB])
  const past = harness({ size: MiB, status: () => 99 * MiB })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(MiB)), { name: 'a.pdf', type: '' }, past.api, { resume: { upload_id: 'u_1', chunk_bytes: MiB } }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'gone' && /cannot go on/.test(e.message))
})

test('an upload the harness no longer holds (it restarted) is said so; a send again resumes one it holds, or starts over', async () => {
  const lost = harness({ chunk: MiB, fail: ({ n }) => (n === 2 ? status(404, 'no such upload') : null) })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(3 * MiB)), { name: 'a.mov', type: '' }, lost.api, { wait: noWait }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'gone' && /restarted/.test(e.message))
  // resumed: where the harness got, then on — no new upload
  const held = harness({ chunk: MiB, size: 3 * MiB, status: () => 2 * MiB })
  const started: { upload_id: string; chunk_bytes: number }[] = []
  await uploadInChunks(asBlob(new HugeFile(3 * MiB)), { name: 'a.mov', type: '' }, held.api, { resume: { upload_id: 'u_1', chunk_bytes: MiB }, onStart: (s) => started.push(s) })
  assert.deepEqual(held.puts.map((p) => p.offset), [2 * MiB])
  assert.deepEqual(held.log, ['status', 'complete'])
  assert.equal(started.length, 0)
  // the one a send before began is gone: started over, from 0
  const over = harness({ chunk: MiB, size: 2 * MiB, status: (r) => (r === 0 ? status(404) : r) })
  await uploadInChunks(asBlob(new HugeFile(2 * MiB)), { name: 'a.mov', type: '' }, over.api, { resume: { upload_id: 'u_old', chunk_bytes: MiB }, onStart: (s) => started.push(s) })
  assert.deepEqual(over.puts.map((p) => p.offset), [0, MiB])
  assert.deepEqual(started, [{ upload_id: 'u_1', chunk_bytes: MiB }])
})

test('a refusal is not retried; transient failures stop as interrupted after the retries, with how far it got', async () => {
  const refusedCreate = harness(); refusedCreate.api.create = async () => { throw status(507, 'no room') }
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(MiB)), { name: 'a.mp4', type: '' }, refusedCreate.api), (e) => e instanceof ChunkedUploadError && e.kind === 'interrupted' && /no room/.test(e.message))
  const refusedType = harness(); refusedType.api.create = async () => { throw status(415, 'not a video') }
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(MiB)), { name: 'a.mp4', type: '' }, refusedType.api), (e) => e instanceof ChunkedUploadError && e.kind === 'refused')
  const refusedChunk = harness({ chunk: MiB, fail: ({ n }) => (n === 2 ? status(422, 'container broken') : null) })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(3 * MiB)), { name: 'a.mp4', type: '' }, refusedChunk.api), (e) => e instanceof ChunkedUploadError && e.kind === 'refused' && e.received === MiB)
  const down = harness({ chunk: MiB, fail: ({ offset }) => (offset >= MiB ? status(502) : null) })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(3 * MiB)), { name: 'a.mp4', type: '' }, down.api, { wait: noWait, retries: 2 }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'interrupted' && e.received === MiB && /interrupted at 1048576 of 3145728/.test(e.message))
  const unfinished = harness({ chunk: MiB, complete: () => { throw status(404) } })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(MiB)), { name: 'a.mp4', type: '' }, unfinished.api), (e) => e instanceof ChunkedUploadError && e.kind === 'gone')
})

test('the person\'s cancel stops the upload and asks the harness to drop it', async () => {
  const controller = new AbortController()
  const h = harness({ chunk: MiB, fail: ({ n }) => { if (n === 2) { controller.abort(); return new DOMException('aborted', 'AbortError') } return null } })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(4 * MiB)), { name: 'a.mp4', type: '' }, h.api, { signal: controller.signal }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'cancelled')
  assert.deepEqual(h.log.slice(-1), ['cancel'])
  assert.equal(h.puts.length, 1)
})

test('a chunk\'s answer must be exactly the chunk\'s end: anything else is asked again, and a count past what was sent is never gone on from', async () => {
  // an answer short of the end (the harness kept less): asked where it got, the rest sent again — no byte skipped
  const short = harness({ chunk: MiB, answer: ({ n, received }) => (n === 2 ? { received: received - 10 } : { received }), status: (r) => (r === 2 * MiB ? MiB : r) })
  await uploadInChunks(asBlob(new HugeFile(3 * MiB)), { name: 'a.mp4', type: '' }, short.api, { wait: async () => assert.fail('no wait: asked at once') })
  assert.deepEqual(short.puts.map((p) => p.offset), [0, MiB, MiB, 2 * MiB])
  assert.deepEqual(short.log.filter((l) => l === 'status').length, 1)
  // an answer past the chunk's end (a next chunk never sent, said held): asked; the harness holding more than was
  // sent stops the upload — it never completes over bytes that did not go
  const skip = harness({ chunk: MiB, answer: ({ n, received }) => (n === 1 ? { received: received + MiB } : { received }), status: () => ({ upload_id: 'u_1', received: 2 * MiB, size: 4 * MiB }) })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(4 * MiB)), { name: 'a.mp4', type: '' }, skip.api, { wait: noWait }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'gone' && /more than the 1048576 sent/.test(e.message))
  assert.deepEqual(skip.puts.map((p) => p.offset), [0])
  assert.equal(skip.log.includes('complete'), false)
  // an answer with no count is no progress either; a harness that keeps answering wrong stops as interrupted
  const garbled = harness({ chunk: MiB, answer: () => ({ received: 'all of it' }), status: () => 0 })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(2 * MiB)), { name: 'a.mp4', type: '' }, garbled.api, { wait: noWait, retries: 2 }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'interrupted' && e.received === 0 && /no byte count/.test(e.message))
  assert.equal(garbled.log.includes('complete'), false)
  // a status of another upload or another file is not gone on with
  const other = harness({ chunk: MiB, size: 9 * MiB, status: () => 0 })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(2 * MiB)), { name: 'a.mp4', type: '' }, other.api, { resume: { upload_id: 'u_1', chunk_bytes: MiB } }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'gone' && /not this file of 2097152/.test(e.message))
  assert.deepEqual(other.puts, [])
})

test('a resume is taken only with a usable upload id and chunk size; otherwise the upload starts over', async () => {
  for (const resume of [{ upload_id: 'u_old', chunk_bytes: 0 }, { upload_id: 'u_old', chunk_bytes: 1.5 }, { upload_id: 'u_old', chunk_bytes: Number.NaN }, { upload_id: 'u_old', chunk_bytes: -MiB },
    { upload_id: '', chunk_bytes: MiB }, { upload_id: 'u_old', chunk_bytes: '1048576' as unknown as number }]) {
    const h = harness({ chunk: MiB })
    await uploadInChunks(asBlob(new HugeFile(2 * MiB)), { name: 'a.pdf', type: '' }, h.api, { resume })
    assert.deepEqual(h.log, ['create a.pdf 2097152 ', 'complete'], JSON.stringify(resume))
    assert.deepEqual(h.puts.map((p) => p.offset), [0, MiB])
  }
})

test('a cancel asks the harness to drop the upload until it confirms, a few times at most; it never says dropped when the harness did not', async () => {
  const cancelAfterFirst = (h: ReturnType<typeof harness>, controller: AbortController) => { const put = h.api.put; h.api.put = async (...a) => { const r = await put(...a); controller.abort(); return r } }
  // busy (409) twice, then dropped: asked three times, after a moment each
  let controller = new AbortController()
  const busy = harness({ chunk: MiB, cancel: (n) => (n < 3 ? status(409, 'a chunk is being written') : { deleted: true }) })
  cancelAfterFirst(busy, controller)
  const waits: number[] = []
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(3 * MiB)), { name: 'a.mp4', type: '' }, busy.api, { signal: controller.signal, wait: async (ms) => { waits.push(ms) } }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'cancelled' && e.dropped && e.message === 'upload cancelled' && e.received === MiB)
  assert.deepEqual([busy.log.filter((l) => l === 'cancel').length, waits, busy.puts.length], [3, [250, 500], 1])
  // the harness never confirms (down, then the network): said so, the upload kept for another ask
  controller = new AbortController()
  const down = harness({ chunk: MiB, cancel: (n) => (n % 2 ? status(503, 'busy') : new TypeError('Failed to fetch')) })
  cancelAfterFirst(down, controller)
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(3 * MiB)), { name: 'a.mp4', type: '' }, down.api, { signal: controller.signal, wait: noWait, retries: 2 }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'cancelled' && !e.dropped && /did not confirm it dropped what arrived \(busy\); remove the file to ask it again/.test(e.message))
  assert.equal(down.log.filter((l) => l === 'cancel').length, 3)
  assert.equal(down.puts.length, 1, 'nothing more sent after the cancel')
  // a cancel during the wait before a retry: no chunk sent again
  controller = new AbortController()
  const flaky = harness({ chunk: MiB, fail: ({ n }) => (n === 1 ? status(503) : null) })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(2 * MiB)), { name: 'a.mp4', type: '' }, flaky.api, { signal: controller.signal, wait: async () => { controller.abort() } }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'cancelled' && e.dropped)
  assert.deepEqual([flaky.puts.length, flaky.log.includes('status')], [0, false])
  // a cancel while a resumed upload is asked where it got drops that upload
  controller = new AbortController()
  const resumed = harness({ chunk: MiB, size: 2 * MiB, status: () => { controller.abort(); return new DOMException('aborted', 'AbortError') } })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(2 * MiB)), { name: 'a.mp4', type: '' }, resumed.api, { signal: controller.signal, resume: { upload_id: 'u_1', chunk_bytes: MiB } }),
    (e) => e instanceof ChunkedUploadError && e.kind === 'cancelled' && e.dropped)
  assert.deepEqual(resumed.log, ['status', 'cancel'])
})

test('dropping an upload: dropped only on {deleted: true} or an upload the harness does not hold; a refusal is not asked again', async () => {
  const api = (answers: unknown[]) => { let n = 0; return { calls: () => n, cancel: async () => { const a = answers[n++]; if (a instanceof Error) throw a; return a } } }
  const gone = api([status(404)])
  assert.deepEqual(await dropUpload(gone, 'u'), { dropped: true, reason: null })
  const refused = api([status(403, 'not yours')])
  assert.deepEqual(await dropUpload(refused, 'u', { wait: noWait }), { dropped: false, reason: 'not yours' })
  assert.equal(refused.calls(), 1)
  const vague = api([{ ok: true }])
  assert.deepEqual(await dropUpload(vague, 'u', { wait: noWait }), { dropped: false, reason: 'the harness did not say it dropped the upload' })
  const late = api([new TypeError('Failed to fetch'), status(502), { deleted: true }])
  assert.deepEqual(await dropUpload(late, 'u', { wait: noWait }), { dropped: true, reason: null })
  assert.equal(late.calls(), 3)
  const never = api(Array.from({ length: 9 }, () => status(500, 'down')))
  assert.deepEqual(await dropUpload(never, 'u', { wait: noWait, retries: 3 }), { dropped: false, reason: 'down' })
  assert.equal(never.calls(), 4)
  // an upload that completed meanwhile is not undone: the harness says so (409, completed) and is not asked again
  const completed = api([Object.assign(status(409, 'the upload completed before it could be cancelled'), { body: { completed: true } })])
  assert.deepEqual(await dropUpload(completed, 'u', { wait: noWait }), { dropped: false, reason: 'the upload completed before it could be cancelled' })
  assert.equal(completed.calls(), 1)
})

test('an empty file opens and completes; an unusable answer to the opening is refused', async () => {
  const h = harness()
  await uploadInChunks(asBlob(new HugeFile(0)), { name: 'empty.pdf', type: 'application/pdf' }, h.api)
  assert.deepEqual([h.puts.length, h.log], [0, ['create empty.pdf 0 application/pdf', 'complete']])
  const bad = harness(); bad.api.create = async () => ({ upload_id: 'u', chunk_bytes: 0, received: 0 })
  await assert.rejects(uploadInChunks(asBlob(new HugeFile(1)), { name: 'a.pdf', type: '' }, bad.api), /no usable upload/)
})
