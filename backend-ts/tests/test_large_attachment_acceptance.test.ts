/** Acceptance (black box) of the ref-v1 PDF / video references — docs/large-file-attachments.md and
 *  docs/large-file-attachments-acceptance.md. Written against the shared contract only: the real app over Hono's
 *  `request` (no socket, no network), scripted models standing in for providers, real files in this run's own temp
 *  folders (big ones sparse). The attachment chain under test (registration, upload, store, hydration, the provider
 *  boundary) is never mocked; the only internals read are the existing repo getters, to look at what was stored.
 *
 *  Until the harness serves REF_ATTACHMENT_ROUTES these tests are expected to fail (red): a 404 is never accepted as
 *  a pass. */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import {
  base64Length, FileFingerprintSchema, FileRefAttachmentSchema, nativeTotalRefusal, PROVIDER_REQUEST_LIMITS, refFileNote, refNativeFor,
  REF_ASSET_KIND, requestLimitsFor, UPLOAD_CHUNK_BYTES, UploadReceivedSchema, UploadStartSchema, UploadStatusSchema, MiB,
  type FileRefAttachment, type Session,
} from '@oasis-code/contract'
import { ModelConfig } from '../src/config.ts'
import { createApp, type App } from '../src/main.ts'
import * as repo from '../src/db/repo.ts'
import { modelResponse, textPart, type ModelMessage } from '../src/llm/messages.ts'
import { Client, HEADERS } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, testConfig, testSettings, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'
import { box, mp4Fixture, pdfFixture } from './file_fixtures.ts'

// ---- fixtures ------------------------------------------------------------------------------------------------------

/** The head of an MP4 whose mdat runs to the end of a file of `total` bytes: ftyp, a video track, the mdat header. */
function mp4Head(total: number): Buffer {
  const ftyp = box('ftyp', Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isom'))
  const moov = box('moov', box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(12)))))
  const mdat = Buffer.alloc(8)
  mdat.writeUInt32BE(total - ftyp.length - moov.length); mdat.write('mdat', 4)
  return Buffer.concat([ftyp, moov, mdat])
}

/** A sparse file: `head` at 0, `tail` at the end, a hole between (nothing but the two ends touches the disk). */
function sparseFile(path: string, size: number, head: Buffer, tail: Buffer = Buffer.alloc(0)): string {
  const fd = openSync(path, 'w')
  try {
    ftruncateSync(fd, size)
    writeSync(fd, head, 0, head.length, 0)
    if (tail.length) writeSync(fd, tail, 0, tail.length, size - tail.length)
  } finally { closeSync(fd) }
  return path
}

/** A sparse MP4 of `size` bytes. */
const sparseMp4 = (path: string, size: number) => sparseFile(path, size, mp4Head(size))

/** A structurally valid PDF of `size` bytes: the small fixture's objects, a hole of NULs (PDF whitespace), then a
 *  classic xref whose offsets still point at the objects, and the trailer. */
function sparsePdf(path: string, size: number): string {
  const small = pdfFixture().toString('latin1')
  const at = small.indexOf('xref\n')
  const head = Buffer.from(small.slice(0, at), 'latin1')
  const table = small.slice(at, small.indexOf('startxref'))
  const tailText = (offset: number) => `\n${table}startxref\n${offset}\n%%EOF\n`
  const probe = Buffer.from(tailText(size), 'latin1').length                    // the offset's digits never shrink the tail
  const tail = Buffer.from(tailText(size - probe + 1), 'latin1')
  return sparseFile(path, size, head, tail)
}

/** Every regular file under a folder (lstat: links are not followed), with its size. */
function filesUnder(root: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = []
  const walk = (dir: string) => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const path = join(dir, name), st = lstatSync(path)
      if (st.isDirectory()) walk(path)
      else if (st.isFile()) out.push({ path, size: st.size })
    }
  }
  walk(root)
  return out
}

// ---- the app -------------------------------------------------------------------------------------------------------

const VIDEO_CAPS = ['video/mp4', 'video/webm', 'video/quicktime']
let app: App | null = null
afterEach(async () => { await app?.close(); app = null })

interface Seen { messages: string; parsed: ModelMessage[]; tools: string[] }

async function setup() {
  const config = testConfig()
  config.models = [
    // no PDF, no video natively: every reference is its one line
    new ModelConfig({ id: 'scripted:text', provider: 'openai', model: 'scripted-text', capabilities: { images: false } }),
    // Anthropic wire limits (32,000,000 bytes) with PDF input; the window is wide so the open token-estimate question
    // (docs/large-file-attachments.md §3) is not what these tests measure
    new ModelConfig({ id: 'scripted:pdf', provider: 'anthropic', model: 'scripted-pdf', capabilities: { images: true, pdf: true }, context_window: 5_000_000 }),
  ]
  config.default_model = 'scripted:text'
  const settings = testSettings()
  app = await createApp(settings, config, { probe: false })
  const seen: Record<string, Seen[]> = { 'scripted:text': [], 'scripted:pdf': [] }
  for (const id of Object.keys(seen)) {
    setModel(app.state, id, scriptedModel((messages, info) => {
      seen[id]!.push({ messages: JSON.stringify(messages), parsed: messages, tools: info.function_tools.map((t) => JSON.stringify(t)) })
      return modelResponse([textPart('seen')])
    }))
  }
  const c = new Client(app)
  const source = buggyRepo()
  const project = await ok<{ id: string }>(await c.post('/api/projects', { source_path: source }))
  const session = await ok<Session>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'large files' }))
  const other = await ok<Session>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'another' }))
  const fixtures = tempDir('oasis-lfa-fixtures-')
  return { app, c, session, other, source, fixtures, seen, data: settings.data_dir }
}

/** A 2xx answer's JSON (201 is as good as 200 for a creation); anything else fails with what came back. */
async function ok<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text()
  expect(res.status >= 200 && res.status < 300, `${res.status} ${text.slice(0, 300)}`).toBe(true)
  return JSON.parse(text) as T
}

/** The status, strictly, with the body in the failure message. */
async function status(res: Response, expected: number | number[]): Promise<Record<string, unknown>> {
  const text = await res.text()
  const want = Array.isArray(expected) ? expected : [expected]
  expect(want.includes(res.status), `expected ${want.join('|')}, got ${res.status} ${text.slice(0, 300)}`).toBe(true)
  try { return JSON.parse(text) as Record<string, unknown> } catch { return {} }
}

const assetCount = (a: App) => Number(a.state.conn.get('SELECT COUNT(*) AS n FROM assets')!.n)

function local(c: Client, sessionId: string, body: unknown, headers: Record<string, string> = HEADERS): Promise<Response> {
  return Promise.resolve(c.app.app.request(`http://localhost/api/sessions/${sessionId}/attachments/local`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}

function put(c: Client, sessionId: string, uid: string, offset: number, bytes: Uint8Array, headers: Record<string, string> = HEADERS): Promise<Response> {
  return Promise.resolve(c.app.app.request(`http://localhost/api/sessions/${sessionId}/uploads/${uid}?offset=${offset}`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes,
  }))
}

async function chat(a: App, c: Client, sessionId: string, body: Record<string, unknown>): Promise<string> {
  const run = await ok<{ id: string }>(await c.post(`/api/sessions/${sessionId}/chat`, body))
  const done = await waitDone(a.state, run.id)
  expect(done.status, JSON.stringify(done).slice(0, 500)).toBe('done')
  return run.id
}

/** The attachment pieces of one asset anywhere in a value (the messages a model was handed). */
function piecesOf(value: unknown, assetId: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (o.asset_id === assetId) out.push(o)
      for (const x of Object.values(o)) walk(x)
    }
  }
  walk(value)
  return out
}

/** How often a string the model was handed appears in its serialized messages. `haystack` is JSON.stringify of the
 *  messages, so the needle is searched in its JSON-encoded form (a note's quotes are escaped there): searching the raw
 *  note would never match a name in quotes, and a `toBe(0)` would pass vacuously (integration fix, 2026-10-14). */
const occurrences = (haystack: string, needle: string) => haystack.split(JSON.stringify(needle).slice(1, -1)).length - 1

/** The first user prompt's content as the model saw it (what a later request must repeat byte for byte). */
function firstUserPrompt(messages: ModelMessage[]): string {
  for (const m of messages) {
    for (const part of (m as { parts?: { part_kind?: string; content?: unknown }[] }).parts ?? []) {
      if (part.part_kind === 'user-prompt') return JSON.stringify(part.content)
    }
  }
  throw new Error('no user prompt')
}

// ---- 1. local registration -----------------------------------------------------------------------------------------

describe('local registration (POST /attachments/local)', () => {
  test('only the token header registers; cookie-only, a wrong token, another origin and an unknown session are refused', async () => {
    const { app, c, session, fixtures } = await setup()
    const clip = sparseMp4(join(fixtures, 'clip.mp4'), 21 * MiB)
    const before = assetCount(app)
    await status(await local(c, session.id, { path: clip }, { cookie: 'oasis_code_session=test-token', origin: 'http://localhost' }), 401)
    await status(await local(c, session.id, { path: clip }, { 'x-oasis-code-token': 'wrong', origin: 'http://localhost' }), 401)
    await status(await local(c, session.id, { path: clip }, { cookie: 'oasis_code_session=wrong', origin: 'http://localhost' }), 401)
    await status(await local(c, session.id, { path: clip }, { ...HEADERS, origin: 'http://evil.example' }), 403)
    await status(await local(c, session.id, { path: clip }, { 'x-oasis-code-token': 'test-token', 'sec-fetch-site': 'cross-site' }), 403)
    await status(await local(c, 's_does_not_exist', { path: clip }), 404)
    expect(assetCount(app)).toBe(before)
    // the header (the desktop app's main process) registers it
    const ref = FileRefAttachmentSchema.parse(await ok(await local(c, session.id, { path: clip })))
    expect(ref.origin).toBe('local')
    expect(assetCount(app)).toBe(before + 1)
  })

  test('a 64 MiB video becomes a ref-v1 reference: origin local, sha256 null, its real path frozen; nothing copied, no bytes stored', async () => {
    const { app, c, session, fixtures, data } = await setup()
    const size = 64 * MiB
    const clip = sparseMp4(join(fixtures, 'holiday clip.mp4'), size)
    const link = join(fixtures, 'linked.mp4'); symlinkSync(clip, link)
    const before = filesUnder(data).filter((f) => f.size >= 20 * MiB)
    const raw = await ok<Record<string, unknown>>(await local(c, session.id, { path: link, media_type: 'video/mp4' }))
    const ref = FileRefAttachmentSchema.parse(raw) as FileRefAttachment
    expect(ref).toMatchObject({ representation: 'ref-v1', origin: 'local', sha256: null, file_kind: 'video', media_type: 'video/mp4', bytes: size })
    expect(ref.location).toBe(realpathSync(clip))                                       // the real path, not the link
    expect(isAbsolute(ref.location)).toBe(true)
    expect(typeof ref.name === 'string' && ref.name.length > 0).toBe(true)
    // zero copy: no file of that size appeared anywhere in the data directory (store, workspaces, sandboxes)
    expect(filesUnder(data).filter((f) => f.size >= 20 * MiB)).toEqual(before)
    // the asset row: a file_ref with the harness's own fingerprint of the file; no bytes, no base64
    const asset = repo.getAsset(app.state.conn, ref.asset_id)!
    expect(asset.kind).toBe(REF_ASSET_KIND)
    const st = statSync(clip, { bigint: true })
    expect(FileFingerprintSchema.parse(asset.meta.fingerprint)).toEqual({
      dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtime_ns: String(st.mtimeNs), ctime_ns: String(st.ctimeNs),
    })
    const stored = JSON.stringify(asset)
    expect(stored.length).toBeLessThan(8192)
    expect(stored).not.toContain(mp4Head(size).toString('base64').slice(0, 24))
    expect(stored).not.toContain(';base64,')
    // a local reference is never served back over HTTP
    await status(await c.get(`/api/sessions/${session.id}/attachments/${ref.asset_id}`), 403)
    // the same file again: the same frozen location
    const again = FileRefAttachmentSchema.parse(await ok(await local(c, session.id, { path: clip })))
    expect(again.location).toBe(ref.location)
    expect(again.bytes).toBe(size)
  })

  test('client-sent metadata never widens anything: location, sha256, origin, bytes and fingerprint come from the file', async () => {
    const { app, c, session, fixtures } = await setup()
    const clip = sparseMp4(join(fixtures, 'clip.mp4'), 21 * MiB)
    const forged = {
      path: clip, location: '/etc/hosts', sha256: 'a'.repeat(64), origin: 'upload', bytes: 1, representation: 'native-v1',
      fingerprint: { dev: '1', ino: '1', size: '1', mtime_ns: '1', ctime_ns: '1' }, asset_id: 'a_forged', storage_path: '../../escape',
    }
    const ref = FileRefAttachmentSchema.parse(await ok(await local(c, session.id, forged)))
    expect(ref).toMatchObject({ origin: 'local', sha256: null, bytes: 21 * MiB, location: realpathSync(clip), representation: 'ref-v1' })
    expect(ref.asset_id).not.toBe('a_forged')
    const fp = FileFingerprintSchema.parse(repo.getAsset(app.state.conn, ref.asset_id)!.meta.fingerprint)
    expect(fp.size).toBe(String(21 * MiB))
    expect(fp.ino).toBe(String(statSync(clip, { bigint: true }).ino))
    // a declared type does not make text a video: the head decides
    const text = join(fixtures, 'fake.mp4'); writeFileSync(text, 'just some words, not a container\n'.repeat(100))
    await status(await local(c, session.id, { path: text, media_type: 'video/mp4', name: 'fake.mp4' }), 422)
    const note = join(fixtures, 'notes.md'); writeFileSync(note, '# not a PDF or a video\n')
    await status(await local(c, session.id, { path: note, media_type: 'application/pdf' }), 422)
  })

  test('nothing that is not a regular PDF/video file outside the denied places registers, and nothing is left behind', async () => {
    const { app, c, session, fixtures, data, source } = await setup()
    const before = assetCount(app)
    await status(await local(c, session.id, { path: join(fixtures, 'missing.mp4') }), 422)          // does not exist
    await status(await local(c, session.id, { path: 'clip.mp4' }), 422)                               // not absolute
    const dir = join(fixtures, 'folder.mp4'); mkdirSync(dir)
    await status(await local(c, session.id, { path: dir }), 422)                                      // a directory
    // a FIFO: refused from lstat, never opened (a reader would block until a writer comes)
    const fifo = join(fixtures, 'pipe.mp4')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    const writer = spawn('sh', ['-c', `sleep 20 > '${fifo}'`], { stdio: 'ignore' })          // would unblock an open reader
    try {
      const started = Date.now()
      const res = await Promise.race([local(c, session.id, { path: fifo }), new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('FIFO registration hung')), 10_000))])
      await status(res, 422)
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally { writer.kill('SIGKILL') }
    // the harness's data directory (directly and through a link from the temp folder) — 403, never a fallback
    const inData = sparseMp4(join(data, 'planted.mp4'), 21 * MiB)
    await status(await local(c, session.id, { path: inData }), 403)
    const toData = join(fixtures, 'innocent.mp4'); symlinkSync(inData, toData)
    await status(await local(c, session.id, { path: toData }), 403)
    // the project's own source checkout (the snapshot's source): 403
    const inSource = sparseMp4(join(source, 'recording.mp4'), 21 * MiB)
    await status(await local(c, session.id, { path: inSource }), 403)
    // the harness's own database: in the data directory and not a video either way
    await status(await local(c, session.id, { path: join(data, 'index.db') }), [403, 422])
    expect(assetCount(app)).toBe(before)
  })
})

// ---- 2. the chunked upload -----------------------------------------------------------------------------------------

const PATTERN_HEAD_BYTES = 4096
/** The byte at `p` of the big upload: the MP4 head, then a position-dependent pattern (any slice is checkable). */
function uploadBytes(total: number, start: number, end: number): Uint8Array {
  const head = mp4Head(total), out = new Uint8Array(end - start)
  for (let p = start; p < end; p++) out[p - start] = p < head.length ? head[p]! : ((Math.imul(p, 2654435761) >>> 24) ^ (p >>> 13)) & 0xff
  return out
}

describe('chunked upload (POST/GET/PUT/complete/DELETE …/uploads)', () => {
  test('a >128 MiB video in order: resume from GET, offset mismatch 409, streamed sha256, one stored copy, ranged download', async () => {
    const { app, c, session, other, data } = await setup()
    const C = UPLOAD_CHUNK_BYTES, total = 4 * C + PATTERN_HEAD_BYTES + 1                  // past the 128 MiB body bound
    const start = UploadStartSchema.parse(await ok(await c.post(`/api/sessions/${session.id}/uploads`, { name: 'big.mp4', size: total, type: 'video/mp4' })))
    expect(start.chunk_bytes).toBe(UPLOAD_CHUNK_BYTES)
    expect(start.received).toBe(0)
    const uid = start.upload_id
    const hash = createHash('sha256')
    let offset = 0
    while (offset < total) {
      const chunk = uploadBytes(total, offset, Math.min(total, offset + C))
      if (offset === C) {
        // resume: the status says where to go on; the wrong offsets are refused with what arrived, nothing written
        expect(UploadStatusSchema.parse(await ok(await c.get(`/api/sessions/${session.id}/uploads/${uid}`)))).toEqual({ upload_id: uid, received: C, size: total })
        expect((await status(await put(c, session.id, uid, 0, chunk), 409)).received).toBe(C)
        expect((await status(await put(c, session.id, uid, C + 1, chunk), 409)).received).toBe(C)
        expect((await status(await put(c, session.id, uid, C - 1, chunk), 409)).received).toBe(C)
        // completing early: 409, the upload stays
        await status(await c.post(`/api/sessions/${session.id}/uploads/${uid}/complete`), 409)
        expect(UploadStatusSchema.parse(await ok(await c.get(`/api/sessions/${session.id}/uploads/${uid}`))).received).toBe(C)
      }
      expect(UploadReceivedSchema.parse(await ok(await put(c, session.id, uid, offset, chunk)))).toEqual({ received: offset + chunk.length })
      hash.update(chunk)
      offset += chunk.length
    }
    const ref = FileRefAttachmentSchema.parse(await ok(await c.post(`/api/sessions/${session.id}/uploads/${uid}/complete`))) as FileRefAttachment
    expect(ref).toMatchObject({ representation: 'ref-v1', origin: 'upload', file_kind: 'video', media_type: 'video/mp4', bytes: total, sha256: hash.digest('hex') })
    expect(isAbsolute(ref.location)).toBe(true)
    expect(statSync(ref.location).size).toBe(total)
    const ws = repo.getWorkspace(app.state.conn, session.workspace_id!)!
    expect(ref.location.startsWith(ws.path)).toBe(false)                                  // never copied into the worktree
    // exactly one file of that size in the data directory: no staging copy left, no second copy
    expect(filesUnder(data).filter((f) => f.size === total).map((f) => f.path)).toEqual([realpathSync(ref.location)])
    expect(filesUnder(data).some((f) => basename(f.path).includes(uid))).toBe(false)
    // the stored row: no bytes, no base64
    const asset = repo.getAsset(app.state.conn, ref.asset_id)!
    expect(asset.kind).toBe(REF_ASSET_KIND)
    expect(JSON.stringify(asset).length).toBeLessThan(8192)
    // the download: whole (headers only; the body is not read) and by ranges, byte for byte
    const url = `/api/sessions/${session.id}/attachments/${ref.asset_id}`
    const whole = await c.get(url)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-length')).toBe(String(total))
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(whole.headers.get('content-disposition') ?? '').toContain('attachment')
    await whole.body?.cancel()
    for (const [range, from, to] of [
      ['bytes=0-63', 0, 64], [`bytes=${C - 8}-${C + 7}`, C - 8, C + 8], [`bytes=${3 * C + 100}-${3 * C + 4195}`, 3 * C + 100, 3 * C + 4196],
      ['bytes=-17', total - 17, total], [`bytes=${total - 5}-`, total - 5, total],
    ] as const) {
      const res = await c.get(url, undefined, { range })
      expect(res.status, range).toBe(206)
      expect(res.headers.get('content-range')).toBe(`bytes ${from}-${to - 1}/${total}`)
      expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(uploadBytes(total, from, to))), range).toBe(true)
    }
    const beyond = await c.get(url, undefined, { range: `bytes=${total}-` })
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get('content-range')).toBe(`bytes */${total}`)
    await beyond.body?.cancel()
    // another session never sees it
    await status(await c.get(`/api/sessions/${other.id}/attachments/${ref.asset_id}`), 404)
  }, 180_000)

  test('kinds, sizes and bounds: 415 for other kinds and a lying head, 413 over chunk_bytes or size, 404 unknown, 409 incomplete', async () => {
    const { app, c, session } = await setup()
    const before = assetCount(app)
    const start = (body: unknown) => c.post(`/api/sessions/${session.id}/uploads`, body)
    await status(await start({ name: 'archive.zip', size: 10, type: 'application/zip' }), 415)
    await status(await start({ name: 'module.ts', size: 10, type: '' }), 415)            // .ts is never video
    await status(await start({ name: 'song.mp3', size: 10, type: 'audio/mpeg' }), 415)
    // an upload of a small real MP4
    const clip = mp4Fixture()
    const up = UploadStartSchema.parse(await ok(await start({ name: 'clip.mp4', size: clip.length, type: 'video/mp4' })))
    await status(await put(c, session.id, up.upload_id, 0, Buffer.concat([clip, Buffer.from('x')])), 413)      // past size
    expect(UploadStatusSchema.parse(await ok(await c.get(`/api/sessions/${session.id}/uploads/${up.upload_id}`))).received).toBe(0)
    expect(UploadReceivedSchema.parse(await ok(await put(c, session.id, up.upload_id, 0, clip.subarray(0, 40))))).toEqual({ received: 40 })
    await status(await c.post(`/api/sessions/${session.id}/uploads/${up.upload_id}/complete`), 409)
    expect((await status(await put(c, session.id, up.upload_id, 10, clip.subarray(10)), 409)).received).toBe(40)
    await status(await put(c, session.id, up.upload_id, 40, Buffer.concat([clip.subarray(40), Buffer.from('extra')])), 413)
    expect(UploadReceivedSchema.parse(await ok(await put(c, session.id, up.upload_id, 40, clip.subarray(40))))).toEqual({ received: clip.length })
    const ref = FileRefAttachmentSchema.parse(await ok(await c.post(`/api/sessions/${session.id}/uploads/${up.upload_id}/complete`)))
    expect(ref).toMatchObject({ origin: 'upload', bytes: clip.length, sha256: createHash('sha256').update(clip).digest('hex') })
    const got = await c.get(`/api/sessions/${session.id}/attachments/${ref.asset_id}`)
    expect(got.status).toBe(200)
    expect(Buffer.from(await got.arrayBuffer()).equals(clip)).toBe(true)
    // one chunk larger than chunk_bytes: 413, nothing taken
    const big = UploadStartSchema.parse(await ok(await start({ name: 'long.mp4', size: 3 * UPLOAD_CHUNK_BYTES, type: 'video/mp4' })))
    await status(await put(c, session.id, big.upload_id, 0, new Uint8Array(big.chunk_bytes + 1)), 413)
    expect(UploadStatusSchema.parse(await ok(await c.get(`/api/sessions/${session.id}/uploads/${big.upload_id}`))).received).toBe(0)
    // a name that says video over bytes that are not: 415 at complete, and the staging is gone
    const words = Buffer.from('these are words and not a video container at all\n')
    const liar = UploadStartSchema.parse(await ok(await start({ name: 'liar.mp4', size: words.length, type: 'video/mp4' })))
    await ok(await put(c, session.id, liar.upload_id, 0, words))
    await status(await c.post(`/api/sessions/${session.id}/uploads/${liar.upload_id}/complete`), 415)
    await status(await c.get(`/api/sessions/${session.id}/uploads/${liar.upload_id}`), 404)
    // unknown uploads
    for (const res of [
      await c.get(`/api/sessions/${session.id}/uploads/u_unknown`), await put(c, session.id, 'u_unknown', 0, clip),
      await c.post(`/api/sessions/${session.id}/uploads/u_unknown/complete`), await c.delete(`/api/sessions/${session.id}/uploads/u_unknown`),
    ]) await status(res, 404)
    expect(assetCount(app)).toBe(before + 1)                                            // only the one completed upload
  })

  test('another session cannot see, write, complete or cancel an upload; cookie works, another origin does not', async () => {
    const { c, session, other } = await setup()
    const clip = mp4Fixture()
    const up = UploadStartSchema.parse(await ok(await c.post(`/api/sessions/${session.id}/uploads`, { name: 'clip.mp4', size: clip.length, type: 'video/mp4' })))
    await ok(await put(c, session.id, up.upload_id, 0, clip.subarray(0, 30)))
    for (const res of [
      await c.get(`/api/sessions/${other.id}/uploads/${up.upload_id}`), await put(c, other.id, up.upload_id, 30, clip.subarray(30)),
      await c.post(`/api/sessions/${other.id}/uploads/${up.upload_id}/complete`), await c.delete(`/api/sessions/${other.id}/uploads/${up.upload_id}`),
    ]) await status(res, [403, 404])
    expect(UploadStatusSchema.parse(await ok(await c.get(`/api/sessions/${session.id}/uploads/${up.upload_id}`))).received).toBe(30)
    // the ordinary auth: the cookie alone is enough for uploads (the page uses them), a foreign origin never
    const cookie = { cookie: 'oasis_code_session=test-token', origin: 'http://localhost' }
    UploadStartSchema.parse(await ok(await c.post(`/api/sessions/${session.id}/uploads`, { name: 'b.pdf', size: 10, type: 'application/pdf' }, cookie)))
    await status(await c.post(`/api/sessions/${session.id}/uploads`, { name: 'b.pdf', size: 10, type: 'application/pdf' }, { ...HEADERS, origin: 'http://evil.example' }), 403)
    await status(await put(c, session.id, up.upload_id, 30, clip.subarray(30), { ...HEADERS, origin: 'http://evil.example' }), 403)
    await status(await c.get(`/api/sessions/${session.id}/uploads/${up.upload_id}`, undefined, { 'x-oasis-code-token': 'wrong' }), 401)
    // the owner finishes it
    expect(UploadReceivedSchema.parse(await ok(await put(c, session.id, up.upload_id, 30, clip.subarray(30)))).received).toBe(clip.length)
    FileRefAttachmentSchema.parse(await ok(await c.post(`/api/sessions/${session.id}/uploads/${up.upload_id}/complete`)))
  })

  test('DELETE drops the upload and what arrived: no record, no staged bytes, no asset', async () => {
    const { app, c, session, data } = await setup()
    const before = assetCount(app)
    const filesBefore = filesUnder(data).length
    const size = UPLOAD_CHUNK_BYTES + 1000
    const up = UploadStartSchema.parse(await ok(await c.post(`/api/sessions/${session.id}/uploads`, { name: 'drop.mp4', size, type: 'video/mp4' })))
    await ok(await put(c, session.id, up.upload_id, 0, uploadBytes(size, 0, UPLOAD_CHUNK_BYTES)))
    expect(filesUnder(data).some((f) => f.size === UPLOAD_CHUNK_BYTES)).toBe(true)        // the staged bytes exist somewhere
    expect(await ok<Record<string, unknown>>(await c.delete(`/api/sessions/${session.id}/uploads/${up.upload_id}`))).toEqual({ deleted: true })
    await status(await c.get(`/api/sessions/${session.id}/uploads/${up.upload_id}`), 404)
    await status(await put(c, session.id, up.upload_id, UPLOAD_CHUNK_BYTES, uploadBytes(size, UPLOAD_CHUNK_BYTES, size)), 404)
    await status(await c.post(`/api/sessions/${session.id}/uploads/${up.upload_id}/complete`), 404)
    await status(await c.delete(`/api/sessions/${session.id}/uploads/${up.upload_id}`), 404)
    expect(filesUnder(data).some((f) => f.size >= UPLOAD_CHUNK_BYTES || basename(f.path).includes(up.upload_id))).toBe(false)
    expect(filesUnder(data).length).toBeLessThanOrEqual(filesBefore)
    expect(assetCount(app)).toBe(before)
  })
})

// ---- 3. what the model sees ----------------------------------------------------------------------------------------

describe('scripted runs: a reference the route does not take', () => {
  test('the model sees only the fixed line, the same on every request; the history prefix and the tools never change; the run goes on after the file is gone', async () => {
    const { app, c, session, fixtures, seen } = await setup()
    const clip = sparseMp4(join(fixtures, 'trip "day 1".mp4'), 64 * MiB)
    const localRef = FileRefAttachmentSchema.parse(await ok(await local(c, session.id, { path: clip }))) as FileRefAttachment
    const small = mp4Fixture()
    const up = UploadStartSchema.parse(await ok(await c.post(`/api/sessions/${session.id}/uploads`, { name: 'small.mp4', size: small.length, type: 'video/mp4' })))
    await ok(await put(c, session.id, up.upload_id, 0, small))
    const upRef = FileRefAttachmentSchema.parse(await ok(await c.post(`/api/sessions/${session.id}/uploads/${up.upload_id}/complete`))) as FileRefAttachment
    const notes = [refFileNote(localRef), refFileNote(upRef)]
    const text = seen['scripted:text']!

    const first = await chat(app, c, session.id, { text: 'what is in these clips?', model: 'scripted:text', attachments: [localRef.asset_id, upRef.asset_id] })
    expect(text).toHaveLength(1)
    for (const note of notes) expect(occurrences(text[0]!.messages, note)).toBe(1)
    const prompt = firstUserPrompt(text[0]!.parsed)
    const history1 = repo.getRunHistory(app.state.conn, first)!

    const second = await chat(app, c, session.id, { text: 'and again', model: 'scripted:text' })
    const third = await (async () => { unlinkSync(clip); return chat(app, c, session.id, { text: 'the original is gone; go on', model: 'scripted:text' }) })()
    expect(text).toHaveLength(3)
    for (const s of text) {
      for (const note of notes) expect(occurrences(s.messages, note), note).toBe(1)
      expect(s.messages).not.toContain(';base64,')
      expect(s.messages).not.toContain(Buffer.from(small).toString('base64'))
      expect(s.messages).not.toContain(mp4Head(64 * MiB).toString('base64').slice(0, 24))
      for (const ref of [localRef, upRef]) for (const piece of piecesOf(s.parsed, ref.asset_id)) expect(piece.data).toBeUndefined()
      expect(firstUserPrompt(s.parsed)).toBe(prompt)                                      // the same words, byte for byte
      expect(s.tools).toEqual(text[0]!.tools)                                             // the same tools, in the same order
    }
    // append-only: each run's history starts with the one before it, and the earlier record is untouched
    const history2 = repo.getRunHistory(app.state.conn, second)!, history3 = repo.getRunHistory(app.state.conn, third)!
    expect(JSON.parse(history2).slice(0, JSON.parse(history1).length)).toEqual(JSON.parse(history1))
    expect(JSON.parse(history3).slice(0, JSON.parse(history2).length)).toEqual(JSON.parse(history2))
    expect(repo.getRunHistory(app.state.conn, first)).toBe(history1)
    for (const h of [history1, history2, history3]) {
      expect(h).not.toContain('its content is not in this message')                     // the record keeps the reference, not the words
      expect(h).not.toContain(';base64,')
      expect(h).toContain(localRef.asset_id)
    }
  }, 120_000)
})

// ---- 4. native budgets ----------------------------------------------------------------------------------------------

describe('native budget: the contract (pure)', () => {
  const pdf = (bytes: number) => ({ name: 'doc.pdf', media_type: 'application/pdf', bytes })
  const video = (bytes: number, media_type = 'video/mp4') => ({ name: 'clip.mp4', media_type, bytes })
  const pdfCaps = { images: true, pdf: true }, geminiCaps = { images: true, pdf: true, video: VIDEO_CAPS }
  const anthropic = requestLimitsFor({ protocol: 'anthropic' }), google = requestLimitsFor({ protocol: 'google' })
  const openai = requestLimitsFor({ protocol: 'openai', url: 'https://api.openai.com/v1/responses' })
  const codex = requestLimitsFor({ protocol: 'openai', url: 'https://chatgpt.com/backend-api/codex/responses' })

  test('the routes map to their hard limits', () => {
    expect(anthropic).toBe(PROVIDER_REQUEST_LIMITS.anthropic)
    expect(google).toBe(PROVIDER_REQUEST_LIMITS.google)
    expect(openai).toBe(PROVIDER_REQUEST_LIMITS.openai_api)
    expect(codex).toBe(PROVIDER_REQUEST_LIMITS.codex)
    expect(requestLimitsFor({ protocol: 'openai', url: 'not a url' })).toBe(PROVIDER_REQUEST_LIMITS.openai_api)
    expect(requestLimitsFor({})).toBe(PROVIDER_REQUEST_LIMITS.app_cap)
    expect(base64Length(0)).toBe(0); expect(base64Length(1)).toBe(4); expect(base64Length(3)).toBe(4); expect(base64Length(4)).toBe(8)
  })

  test('past 20 MiB but inside what the provider takes stays native; past the hard limit it is the stable path line', () => {
    // Anthropic, 32,000,000 bytes of JSON: 21 MiB of PDF (28 MB of base64) goes; the exact edge is base64 < limit
    expect(refNativeFor(pdfCaps, anthropic, pdf(21 * MiB))).toBe(true)
    expect(refNativeFor(pdfCaps, anthropic, pdf(23_999_997))).toBe(true)
    expect(refNativeFor(pdfCaps, anthropic, pdf(23_999_998))).toBe(false)
    expect(refNativeFor(pdfCaps, anthropic, pdf(30_000_000))).toBe(false)
    expect(refNativeFor(pdfCaps, anthropic, video(1000))).toBe(false)                   // no video on that route at all
    expect(refNativeFor({ images: true }, anthropic, pdf(1000))).toBe(false)             // no PDF capability
    // Gemini, 100 MB: a 70 MB mp4 goes, an 80 MB one does not; a video MIME it does not list never goes
    expect(refNativeFor(geminiCaps, google, video(70_000_000))).toBe(true)
    expect(refNativeFor(geminiCaps, google, video(80_000_000))).toBe(false)
    expect(refNativeFor(geminiCaps, google, video(1000, 'video/x-matroska'))).toBe(false)
    expect(refNativeFor(geminiCaps, google, pdf(70_000_000))).toBe(true)
    // OpenAI API: raw input files strictly under 50,000,000
    expect(refNativeFor(pdfCaps, openai, pdf(49_999_999))).toBe(true)
    expect(refNativeFor(pdfCaps, openai, pdf(50_000_000))).toBe(false)
    // Codex / unknown: the 128 MiB application cap on the encoded body
    expect(refNativeFor(pdfCaps, codex, pdf(90_000_000))).toBe(true)
    expect(refNativeFor(pdfCaps, codex, pdf(100 * MiB))).toBe(false)
    // the line for a reference not sent: a pure function of the frozen fields, JSON-escaped
    const ref = { name: 'a "quoted"\nname.mp4', media_type: 'video/mp4', bytes: 80_000_000, location: '/Users/x/Movies/a "q".mp4' }
    const line = refFileNote(ref)
    expect(refFileNote({ ...ref })).toBe(line)
    expect(line).toContain(JSON.stringify(ref.location))
    expect(line).toContain(JSON.stringify(ref.name))
    expect(line).toContain('80000000 bytes')
    expect(line).not.toContain('\n')
    expect(line).not.toContain('base64')
  })

  test('the request total is refused across several attachments (history included), never by quietly demoting an earlier one', () => {
    const one = { bytes: 21 * MiB, input_file: true }
    expect(nativeTotalRefusal(anthropic, [], 'route')).toBeNull()
    expect(nativeTotalRefusal(anthropic, [one], 'route')).toBeNull()
    // each fits alone; together (the history's one and the new one) they do not: refused, before anything is read
    expect(refNativeFor(pdfCaps, anthropic, pdf(one.bytes))).toBe(true)
    const refused = nativeTotalRefusal(anthropic, [one, one], 'scripted route')
    expect(refused).toContain('scripted route')
    expect(refused).toContain(String(anthropic.request_bytes))
    // the earlier one's own verdict does not depend on what came after it
    expect(refNativeFor(pdfCaps, anthropic, pdf(one.bytes))).toBe(true)
    // Gemini: 3 × 30 MB of video (120 MB encoded) is refused; 2 are not
    expect(nativeTotalRefusal(google, [{ bytes: 30_000_000, input_file: false }, { bytes: 30_000_000, input_file: false }], 'g')).toBeNull()
    expect(nativeTotalRefusal(google, Array(3).fill({ bytes: 30_000_000, input_file: false }), 'g')).not.toBeNull()
    // OpenAI API: raw input files total at most 50,000,000; images (not input files) do not count there
    expect(nativeTotalRefusal(openai, [{ bytes: 25_000_000, input_file: true }, { bytes: 25_000_000, input_file: true }], 'o')).toBeNull()
    expect(nativeTotalRefusal(openai, [{ bytes: 25_000_000, input_file: true }, { bytes: 25_000_001, input_file: true }], 'o')).not.toBeNull()
    expect(nativeTotalRefusal(openai, [{ bytes: 25_000_000, input_file: true }, { bytes: 25_000_000, input_file: true }, { bytes: 5 * MiB, input_file: false }], 'o')).toBeNull()
  })
})

describe('native budget: through the app', () => {
  test('a 21 MiB local PDF goes native on an Anthropic route, a 30 MB one is its line; the total over the limit is refused at the route, the earlier native kept', async () => {
    const { app, c, session, fixtures, seen } = await setup()
    const register = async (name: string, size: number) =>
      FileRefAttachmentSchema.parse(await ok(await local(c, session.id, { path: sparsePdf(join(fixtures, name), size) }))) as FileRefAttachment
    const fits = await register('fits.pdf', 21 * MiB)
    const over = await register('over.pdf', 30_000_000)
    const fits2 = await register('fits-too.pdf', 21 * MiB)
    const pdfSeen = seen['scripted:pdf']!

    // two that each fit but not together, in one message: refused before the model is asked, nothing recorded
    const both = await c.post(`/api/sessions/${session.id}/chat`, { text: 'both', model: 'scripted:pdf', attachments: [fits.asset_id, fits2.asset_id] })
    await status(both, [400, 413, 422])
    expect(pdfSeen).toHaveLength(0)

    const first = await chat(app, c, session.id, { text: 'read these', model: 'scripted:pdf', attachments: [fits.asset_id, over.asset_id] })
    expect(pdfSeen).toHaveLength(1)
    const sent = piecesOf(pdfSeen[0]!.parsed, fits.asset_id).filter((p) => typeof p.data === 'string')
    expect(sent).toHaveLength(1)
    expect((sent[0]!.data as string).length).toBe(base64Length(fits.bytes))
    expect(Buffer.from((sent[0]!.data as string).slice(0, 12), 'base64').toString('latin1').startsWith('%PDF-')).toBe(true)
    expect(occurrences(pdfSeen[0]!.messages, refFileNote(over))).toBe(1)
    expect(occurrences(pdfSeen[0]!.messages, refFileNote(fits))).toBe(0)
    const history1 = repo.getRunHistory(app.state.conn, first)!
    expect(history1.length).toBeLessThan(1_000_000)                                      // the record never holds the bytes
    expect(history1).not.toContain(';base64,')

    // the history's native PDF plus a new one: refused at the route's budget, not by demoting the old one to a path
    await status(await c.post(`/api/sessions/${session.id}/chat`, { text: 'one more', model: 'scripted:pdf', attachments: [fits2.asset_id] }), [400, 413, 422])
    expect(pdfSeen).toHaveLength(1)
    expect(repo.getRunHistory(app.state.conn, first)).toBe(history1)

    // the conversation goes on: the earlier PDF is still sent as itself, the large one still as its line
    await chat(app, c, session.id, { text: 'go on', model: 'scripted:pdf' })
    expect(pdfSeen).toHaveLength(2)
    const again = piecesOf(pdfSeen[1]!.parsed, fits.asset_id).filter((p) => typeof p.data === 'string')
    expect(again).toHaveLength(1)
    expect((again[0]!.data as string).length).toBe(base64Length(fits.bytes))
    expect(occurrences(pdfSeen[1]!.messages, refFileNote(over))).toBe(1)
    expect(firstUserPrompt(pdfSeen[1]!.parsed).length).toBeGreaterThan(0)
    expect(pdfSeen[1]!.tools).toEqual(pdfSeen[0]!.tools)
  }, 180_000)
})
