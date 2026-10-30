/** PDF and video references (ref-v1, docs/large-file-attachments.md), offline (every model scripted):
 *  - the contract: the frozen schema, the one note, the route bounds a native file is judged against;
 *  - the desktop's local registration: the token header only, nothing copied, read or hashed beyond a bounded head,
 *    a link resolved to its canonical real path (a link into a denied place refused), hard links / special files / denied places / control characters refused, other sessions kept out;
 *  - the chunked upload: offsets, resume, turns, cancel, rollback of a broken chunk, restart, more than the server's
 *    128 MiB body bound across chunks (while one request that large is still refused), Range download;
 *  - a run: the same words for a reference on every request, route and run; the history append-only; the tools the
 *    same; a path-only file never read; a native one read once, refused when it changed; the bounds of one request
 *    judged before sending, the draft kept (PDF-only totals need no content read). */

import { afterEach, expect, test } from 'bun:test'
import { closeSync, existsSync, linkSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  AttachmentSchema, FileRefAttachmentSchema, PROVIDER_REQUEST_LIMITS, REF_ATTACHMENT_ROUTES, ROUTES, UPLOAD_CHUNK_BYTES, isFileRefAttachment,
  nativeTotalRefusal, refFileNote, refKindOf, refNativeFor, requestLimitsFor, type Attachment, type FileRefAttachment, type Session,
} from '@oasis-code/contract'
import { ModelConfig } from '../src/config.ts'
import { attachmentPiece, attachmentReader, hydrateAttachments } from '../src/llm/attachments.ts'
import { refAccess, type RefAccess } from '../src/llm/ref_files.ts'
import { routeLimits } from '../src/llm/catalog.ts'
import { postJson } from '../src/llm/http.ts'
import { modelRequest, modelResponse, textPart, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { AnthropicModel, GoogleModel } from '../src/llm/providers.ts'
import { estimateMessages, nativeRefCost, NATIVE_REF_RESERVE_TOKENS } from '../src/agent/context.ts'
import { sessionAttachmentReads, sessionInputFiles } from '../src/agent/attachment_grants.ts'
import { Uploads, UPLOAD_IDLE_MS } from '../src/api/uploads.ts'
import { createApp, type App } from '../src/main.ts'
import * as repo from '../src/db/repo.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, testConfig, testSettings, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'
import { mp4Fixture, pdfFixture } from './file_fixtures.ts'

const GEMINI_VIDEO = ['video/mp4', 'video/webm', 'video/quicktime']
type Body = RequestInit['body']
let app: App | null = null
afterEach(async () => { await app?.close(); app = null })

/** a: Anthropic with PDF; b: OpenAI without PDF or images; g: Gemini with PDF and video. Each records what it was handed. */
async function setup() {
  const config = testConfig()
  config.models = [
    new ModelConfig({ id: 'scripted:a', provider: 'anthropic', model: 'scripted-a', capabilities: { images: true, pdf: true } }),
    new ModelConfig({ id: 'scripted:b', provider: 'openai', model: 'scripted-b', capabilities: { images: false } }),
    new ModelConfig({ id: 'scripted:g', provider: 'google', model: 'scripted-g', capabilities: { images: true, pdf: true, video: GEMINI_VIDEO } }),
  ]
  app = await createApp(testSettings(), config, { probe: false })
  const handed: Record<string, string[]> = { 'scripted:a': [], 'scripted:b': [], 'scripted:g': [] }
  for (const id of Object.keys(handed)) setModel(app.state, id, scriptedModel((messages) => { handed[id]!.push(JSON.stringify(messages)); return modelResponse([textPart('seen')]) }))
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json<Session>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'refs' }))
  const local = (path: string, extra: Record<string, unknown> = {}) => c.post(`/api/sessions/${session.id}/attachments/local`, { path, ...extra })
  const chat = (body: Record<string, unknown>) => c.post(`/api/sessions/${session.id}/chat`, body)
  const raw = (method: string, path: string, body?: Body, headers: Record<string, string> = {}) =>
    Promise.resolve(app!.app.request(`http://localhost${path}`, { method, body: body ?? null, headers: { ...c.headers, ...headers } }))
  return { c, session, project, handed, local, chat, raw }
}

/** A file in a folder of its own (outside every denied place): its bytes, then (sparse) zeros up to `size`. */
function fileAt(name: string, head: Uint8Array, size = head.length): string {
  const path = join(tempDir('oasis-ref-'), name)
  writeFileSync(path, head)
  if (size > head.length) truncateSync(path, size)
  return path
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const refsOf = (state: App['state'], session: Session, cache?: number): RefAccess =>
  refAccess({ lookup: (id) => repo.getAsset(state.conn, id), store: state.store, project: session.project_id, session: session.id, cache_bytes: cache, local: state.runs.localAccess(session.project_id) })
const history = (...refs: Attachment[]): ModelMessage[] => [modelRequest([userPrompt(['look', ...refs.map(attachmentPiece)])])]

test('contract: the frozen reference, its one note, the bounds a native file is judged against; the routes served', async () => {
  const local: FileRefAttachment = { asset_id: 'a_1', name: 'clip "1".mkv', media_type: 'video/x-matroska', bytes: 5_000_000_000, file_kind: 'video', representation: 'ref-v1', origin: 'local', location: '/Users/x/clip "1".mkv', sha256: null }
  expect(JSON.stringify(AttachmentSchema.parse(local))).toBe(JSON.stringify(local))
  for (const bad of [{ ...local, sha256: 'a'.repeat(64) }, { ...local, origin: 'upload' }, { ...local, location: 'clip.mkv' }, { ...local, file_kind: 'pdf' }, { ...local, media_type: 'audio/mpeg' }]) expect(FileRefAttachmentSchema.safeParse(bad).success).toBe(false)
  const note = refFileNote(local)
  expect(note).toBe(refFileNote(JSON.parse(JSON.stringify(local))))
  expect(note).toContain(JSON.stringify(local.location))
  expect(note).toContain('5000000000 bytes')
  const A = requestLimitsFor({ protocol: 'anthropic' }), G = requestLimitsFor({ protocol: 'google' })
  const O = requestLimitsFor({ protocol: 'openai', url: 'https://api.openai.com/v1' }), X = requestLimitsFor({ protocol: 'openai', url: 'https://chatgpt.com/backend-api/codex' })
  expect([A.key, G.key, O.key, X.key]).toEqual(['anthropic', 'google', 'openai_api', 'codex'])
  const pdf = (bytes: number) => ({ name: 'p.pdf', media_type: 'application/pdf', bytes })
  expect(refNativeFor({ pdf: true }, A, pdf(20_000_000))).toBe(true)
  expect(refNativeFor({ pdf: true }, A, pdf(24_000_000))).toBe(false)                  // its base64 alone reaches 32 MB
  expect(refNativeFor({ pdf: true }, O, pdf(49_999_999))).toBe(true)
  expect(refNativeFor({ pdf: true }, O, pdf(50_000_000))).toBe(false)
  expect(refNativeFor({ video: GEMINI_VIDEO }, G, { name: 'v.mp4', media_type: 'video/mp4', bytes: 70_000_000 })).toBe(true)
  expect(refNativeFor({ video: GEMINI_VIDEO }, G, local)).toBe(false)                   // an MKV is not a listed MIME
  expect(nativeTotalRefusal(A, [{ bytes: 15_000_000, input_file: true }, { bytes: 15_000_000, input_file: true }], 'r')).toContain('this request was not sent and the draft is kept')
  expect(refKindOf('a.MOV')?.media_type).toBe('video/quicktime')
  expect(refKindOf('a.ts')).toBeNull()
  for (const r of REF_ATTACHMENT_ROUTES) expect(ROUTES).toContainEqual(r)
  expect(REF_ATTACHMENT_ROUTES.find((r) => r.path.endsWith('/attachments/local'))?.token_header_only).toBe(true)
})

test('a local file is registered where it stands: the token header only, nothing copied or hashed, its head alone read; refusals are final', async () => {
  const { c, session, local } = await setup()
  const state = app!.state
  // a 1.5 GiB sparse PDF (under the 2 GiB file-size bound commands run with here): registered at once, never read
  const big = fileAt('scan.pdf', Buffer.from('%PDF-1.7\n%synthetic\n'), 1536 * 1024 * 1024)
  const started = performance.now()
  const ref = await json<FileRefAttachment>(await local(big, { name: 'My scan.pdf' }))
  expect(performance.now() - started).toBeLessThan(5_000)
  expect(ref).toMatchObject({ name: 'My scan.pdf', media_type: 'application/pdf', bytes: 1536 * 1024 * 1024, file_kind: 'pdf', representation: 'ref-v1', origin: 'local', location: big, sha256: null })
  expect(existsSync(join(state.store.root, session.project_id, 'ref'))).toBe(false)                // nothing copied into the store
  const asset = repo.getAsset(state.conn, ref.asset_id)!
  expect(asset.meta.fingerprint).toMatchObject({ size: String(1536 * 1024 * 1024), ino: String(statSync(big, { bigint: true }).ino) })
  expect(asset.sha256).toBe('')
  // the page's cookie is not enough: only the token header (the desktop app's main process)
  const cookieOnly = new Client(app!, { headers: { cookie: 'oasis_code_session=test-token', origin: 'http://localhost' } })
  expect((await cookieOnly.post(`/api/sessions/${session.id}/attachments/local`, { path: big })).status).toBe(401)
  expect((await cookieOnly.get(`/api/sessions/${session.id}`)).status).toBe(200)                   // the cookie still works elsewhere
  // refused, each for what it is
  const dir = tempDir('oasis-ref-bad-')
  const linked = join(dir, 'link.pdf'); symlinkSync(big, linked)
  const hard = fileAt('hard.pdf', pdfFixture()); linkSync(hard, join(dir, 'second-name.pdf'))
  const fifo = join(dir, 'pipe.pdf'); expect(spawnSync('/usr/bin/mkfifo', [fifo]).status).toBe(0)
  const inData = join(state.settings.data_dir, 'x.pdf'); writeFileSync(inData, pdfFixture())
  const other = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const inOther = join(String(other.source_path), 'other.pdf'); writeFileSync(inOther, pdfFixture())
  const inSnapshotSource = join(String(repo.getProject(state.conn, session.project_id)!.source_path), 'source.pdf'); writeFileSync(inSnapshotSource, pdfFixture())
  const viaLinkedFolder = join(dir, 'folder'); symlinkSync(join(big, '..'), viaLinkedFolder)
  // a link, or a folder reached through a link, names the file it leads to: registered at the file's canonical real
  // path (the desktop app forwards the same canonical path) — intentionally accepted since the integration of
  // 2026-10-14; where the link leads is judged, so a link into a denied place is refused like the place (below)
  for (const via of [linked, join(viaLinkedFolder, 'scan.pdf')]) {
    const viaRef = await json<FileRefAttachment>(await local(via))
    expect(viaRef.location).toBe(realpathSync.native(big))
  }
  const toData = join(dir, 'to-data.pdf'); symlinkSync(inData, toData)
  const cases: [string, number, string][] = [
    ['relative.pdf', 422, 'absolute'], [`${big}\n`, 422, 'control'], [toData, 403, 'data directory'],
    [dir, 422, 'not a regular file'], [fifo, 422, 'not a regular file'], [hard, 403, 'hard links'], [join(dir, 'missing.pdf'), 422, 'no file'],
    [inData, 403, "data directory"],
    // not a PDF or a video by its head and name: 422 on the local route (the contract's status; an upload says 415)
    [fileAt('fake.pdf', Buffer.from('not a pdf at all')), 422, 'first bytes'], [fileAt('clip.mp4', pdfFixture()), 422, 'named as a video'],
  ]
  for (const [path, status, why] of cases) {
    const res = await local(path)
    const body = await res.text()
    expect(res.status, `${path}: ${body}`).toBe(status)
    expect(body, path).toContain(why)
    expect(JSON.parse(body).code, path).toBeUndefined()                                // no copy offered for any of these
  }
  // another project's folder is readable to a command, as it is to the sandbox: the path stands
  expect((await json<FileRefAttachment>(await local(inOther))).location).toBe(realpathSync.native(inOther))
  // this snapshot project's original folder is not (its agents work on the copy): no path, but a copy is offered
  const original = await local(inSnapshotSource)
  expect(original.status).toBe(403)
  expect(await original.json()).toMatchObject({ code: 'copy_instead', detail: expect.stringContaining('original folder') })
  // a link from the original folder into the data directory offers no copy: every place it lies in must allow one
  const sourceDir = String(repo.getProject(state.conn, session.project_id)!.source_path)
  const toDataFromSource = join(sourceDir, 'to-data.pdf'); symlinkSync(inData, toDataFromSource)
  expect(await (await local(toDataFromSource)).json()).not.toHaveProperty('code')
  // another session cannot name it; the reference is not served to a page
  const second = await json<Session>(await c.post(`/api/projects/${session.project_id}/sessions`, { title: 'other' }))
  expect((await c.post(`/api/sessions/${second.id}/chat`, { text: 'x', attachments: [ref.asset_id] })).status).toBe(400)
  expect((await c.get(`/api/sessions/${second.id}/attachments/${ref.asset_id}`)).status).toBe(404)
  const download = await c.get(`/api/sessions/${session.id}/attachments/${ref.asset_id}`)
  expect(download.status).toBe(403)
  expect(await download.text()).toContain('not served')
})

test('a path-only reference: the same note on every request, route and run, never read; the history keeps the reference, append-only; the tools are the same', async () => {
  const { session, local, chat, handed } = await setup()
  const state = app!.state
  const clip = await json<FileRefAttachment>(await local(fileAt('holiday.mkv', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]), 1229 * 1024 * 1024)))
  expect(clip.media_type).toBe('video/x-matroska')
  const note = refFileNote(clip)
  const first = await json(await chat({ text: 'what is in it?', model: 'scripted:b', attachments: [clip.asset_id] }))
  expect((await waitDone(state, String(first.id))).status).toBe('done')
  const second = await json(await chat({ text: 'and now?', model: 'scripted:g' }))
  expect((await waitDone(state, String(second.id))).status).toBe('done')
  // the file moves away: a path-only reference is not checked, the conversation goes on, the words are the same
  rmSync(clip.location)
  const third = await json(await chat({ text: 'once more', model: 'scripted:a' }))
  expect((await waitDone(state, String(third.id))).status).toBe('done')
  for (const id of ['scripted:b', 'scripted:g', 'scripted:a']) {
    expect(handed[id]!.length).toBeGreaterThan(0)
    for (const request of handed[id]!) expect(request.split(JSON.stringify(note).slice(1, -1)).length - 1).toBe(1)
  }
  expect(note).not.toContain(repo.getWorkspace(state.conn, session.workspace_id!)!.path)       // no workspace in the words
  const h1 = JSON.parse(repo.getRunHistory(state.conn, String(first.id))!), h3 = JSON.parse(repo.getRunHistory(state.conn, String(third.id))!)
  expect(h3.slice(0, h1.length)).toEqual(h1)                                                         // append-only
  expect(JSON.stringify(h1)).toContain(clip.location)
  expect(JSON.stringify(h1)).not.toContain('its content is not in this message')                    // the record keeps the reference, not the words
  // the tools are the same with and without a reference
  const tools = (id: string) => (repo.getRun(state.conn, id)!.manifest as { tools?: string[] }).tools
  const schemas = (id: string) => [...new Set(repo.listModelRequests(state.conn, id).map((r) => r.tool_schema_sha256))]
  const plain = await json(await chat({ text: 'no attachment', model: 'scripted:b', fresh: true }))
  await waitDone(state, String(plain.id))
  expect(tools(String(first.id))!.length).toBeGreaterThan(5)
  expect(tools(String(first.id))).toEqual(tools(String(plain.id)))
  expect(schemas(String(first.id))).toHaveLength(1)
  expect(schemas(String(first.id))).toEqual(schemas(String(plain.id)))
  // the estimate counts the note, never 1.2 GiB
  expect(estimateMessages(history(clip))).toBeLessThan(500)
  expect(nativeRefCost({ ...clip, bytes: 24_000_000 } as never)).toBe(NATIVE_REF_RESERVE_TOKENS)
})

test('a native reference: read once for the run, bounded and checked; a local file that changed, or was swapped for a link, is refused — never other bytes', async () => {
  const { session, local } = await setup()
  const state = app!.state
  const doc = await json<FileRefAttachment>(await local(fileAt('paper.pdf', pdfFixture('native ABC'))))
  const refs = refsOf(state, session)
  const read = attachmentReader((id) => repo.getAsset(state.conn, id), (p) => state.store.read(p), session.project_id, session.id)
  const route = { limits: PROVIDER_REQUEST_LIMITS.anthropic, refs }
  const out = JSON.stringify(hydrateAttachments(history(doc), read, { pdf: true }, 'a', null, route))
  expect(out).toContain(pdfFixture('native ABC').toString('base64'))
  hydrateAttachments(history(doc), read, { pdf: true }, 'a', null, route)
  expect(refs.reads).toBe(1)                                                                           // the second request used what was read
  // on a route that does not take it: the note, nothing read
  expect(JSON.stringify(hydrateAttachments(history(doc), read, { images: false }, 'b', null, { limits: PROVIDER_REQUEST_LIMITS.openai_api, refs }))).toContain(JSON.stringify(refFileNote(doc)).slice(1, -1))
  expect(refs.reads).toBe(1)
  // the file changes (one byte more): refused on the next request, though its bytes were cached
  const fd = openSync(doc.location, 'a'); writeSync(fd, '\n'); closeSync(fd)
  expect(() => hydrateAttachments(history(doc), read, { pdf: true }, 'a', null, route)).toThrow('changed or was replaced since it was attached')
  // a fresh reference, then the file renamed away and a link to another file put in its place
  const again = await json<FileRefAttachment>(await local(fileAt('report.pdf', pdfFixture('first'))))
  const decoy = fileAt('decoy.pdf', pdfFixture('decoy'))
  renameSync(again.location, `${again.location}.moved`)
  symlinkSync(decoy, again.location)
  const fresh = refsOf(state, session)
  expect(() => hydrateAttachments(history(again), read, { pdf: true }, 'a', null, { ...route, refs: fresh })).toThrow('cannot be opened')
  expect(fresh.reads).toBe(0)
  // a reference that is not this session's record is refused before anything is touched
  expect(() => hydrateAttachments(history({ ...doc, bytes: doc.bytes + 1 }), read, { pdf: true }, 'a', null, route)).toThrow('does not match its record')
})

test('the bounds of a PDF-only request are judged before content is read: refused with the draft kept; one file too large for the route is named by its path, the same every time', async () => {
  const { session, local, chat, handed } = await setup()
  const state = app!.state
  const head = Buffer.from('%PDF-1.7\n')
  const one = await json<FileRefAttachment>(await local(fileAt('one.pdf', head, 15_000_000)))
  const two = await json<FileRefAttachment>(await local(fileAt('two.pdf', head, 15_000_000)))
  const refs = refsOf(state, session)
  const read = attachmentReader((id) => repo.getAsset(state.conn, id), (p) => state.store.read(p), session.project_id, session.id)
  expect(() => hydrateAttachments(history(one, two), read, { pdf: true }, 'a', null, { limits: PROVIDER_REQUEST_LIMITS.anthropic, refs })).toThrow('this request was not sent and the draft is kept')
  expect(refs.reads).toBe(0)
  const runsBefore = repo.listRuns(state.conn, session.id).length
  const refused = await chat({ text: 'both', model: 'scripted:a', attachments: [one.asset_id, two.asset_id] })
  expect(refused.status).toBe(400)
  expect(await refused.text()).toContain('one request may carry at most 32000000')
  expect(repo.listRuns(state.conn, session.id).length).toBe(runsBefore)                           // nothing started: the draft is the person's
  // one file over the route's bound alone: its path, on this route and the others, every time — however long the history
  const huge = await json<FileRefAttachment>(await local(fileAt('huge.pdf', head, 30_000_000)))
  expect(refNativeFor({ pdf: true }, routeLimits(state.config.models.find((m) => m.id === 'scripted:a')!), huge)).toBe(false)
  for (const text of ['first', 'second', 'third']) {
    const run = await json(await chat({ text, model: 'scripted:a', ...(text === 'first' ? { attachments: [huge.asset_id] } : {}) }))
    expect((await waitDone(state, String(run.id))).status).toBe('done')
  }
  for (const request of handed['scripted:a']!) expect(request).toContain(JSON.stringify(refFileNote(huge)).slice(1, -1))
})

test('the chunked upload: offsets, resume, turns, rollback, cancel, restart — more than 128 MiB across chunks through the real server, one such request still refused; Range download', async () => {
  const { session, raw, c } = await setup()
  const state = app!.state
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req, srv) => app!.fetch(req, srv) })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const H = { 'x-oasis-code-token': 'test-token' }
    const size = 160 * 1024 * 1024
    const body = Buffer.alloc(size)
    mp4Fixture().copy(body, 0)
    for (let i = 4096; i < size; i += 4096) body[i] = i & 0xff
    const start = await (await fetch(`${base}/api/sessions/${session.id}/uploads`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'long.mp4', size, type: 'video/mp4' }) })).json() as { upload_id: string; chunk_bytes: number; received: number }
    expect(start).toMatchObject({ chunk_bytes: UPLOAD_CHUNK_BYTES, received: 0 })
    const url = `${base}/api/sessions/${session.id}/uploads/${start.upload_id}`
    for (let offset = 0; offset < size; offset += UPLOAD_CHUNK_BYTES) {
      const res = await fetch(`${url}?offset=${offset}`, { method: 'PUT', headers: H, body: body.subarray(offset, offset + UPLOAD_CHUNK_BYTES) })
      expect(res.status).toBe(200)
      if (offset === 0) {
        // a resend of the same chunk at its old offset is told where the upload stands
        const stale = await fetch(`${url}?offset=0`, { method: 'PUT', headers: H, body: body.subarray(0, 10) })
        expect(stale.status).toBe(409)
        expect(((await stale.json()) as { received: number }).received).toBe(UPLOAD_CHUNK_BYTES)
        expect(((await (await fetch(url, { headers: H })).json()) as { received: number }).received).toBe(UPLOAD_CHUNK_BYTES)
      }
    }
    const ref = await (await fetch(`${url}/complete`, { method: 'POST', headers: H })).json() as FileRefAttachment
    expect(ref).toMatchObject({ origin: 'upload', bytes: size, sha256: sha(body), media_type: 'video/mp4', representation: 'ref-v1' })
    expect(ref.location).toBe(join(realpathSync(state.store.root), session.project_id, 'ref', `${sha(body)}.mp4`))
    expect(statSync(ref.location).size).toBe(size)
    expect(readdirSync(join(state.settings.data_dir, 'uploads'))).toEqual([])                       // renamed, not copied
    // one request as large as the whole file is refused by the server's own bound, which stays as it was
    const whole = await fetch(`${base}/api/sessions/${session.id}/attachments?name=long.mp4`, { method: 'POST', headers: { ...H, 'content-type': 'video/mp4' }, body })
    expect(whole.status).toBe(413)
    // Range download of the stored upload
    const part = await c.get(`/api/sessions/${session.id}/attachments/${ref.asset_id}`, undefined, { range: 'bytes=4096-4103' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 4096-4103/${size}`)
    expect(Buffer.from(await part.arrayBuffer())).toEqual(body.subarray(4096, 4104))
    expect((await c.get(`/api/sessions/${session.id}/attachments/${ref.asset_id}`, undefined, { range: `bytes=${size}-` })).status).toBe(416)
    // the store keeps one file for the same bytes uploaded again
    const small = pdfFixture('small upload')
    const u = await json<{ upload_id: string }>(await c.post(`/api/sessions/${session.id}/uploads`, { name: 'note.pdf', size: small.length, type: 'application/pdf' }))
    expect((await raw('PUT', `/api/sessions/${session.id}/uploads/${u.upload_id}?offset=0`, small)).status).toBe(200)
    const a = await json<FileRefAttachment>(await raw('POST', `/api/sessions/${session.id}/uploads/${u.upload_id}/complete`))
    const legacyPost = await json<FileRefAttachment>(await raw('POST', `/api/sessions/${session.id}/attachments?name=note.pdf`, small, { 'content-type': 'application/pdf' }))
    expect(legacyPost).toMatchObject({ representation: 'ref-v1', origin: 'upload', sha256: a.sha256, location: a.location })
    expect(legacyPost.asset_id).not.toBe(a.asset_id)
  } finally { server.stop(true) }
})

test('an upload takes turns, rolls back a broken chunk, is cancelled with its bytes, refuses more than it said, and does not outlive a restart', async () => {
  const { session, raw, c } = await setup()
  const state = app!.state
  const data = Buffer.concat([pdfFixture('chunks'), Buffer.alloc(3000, 0x20)])
  const begin = async (size = data.length, name = 'doc.pdf') => (await json<{ upload_id: string }>(await c.post(`/api/sessions/${session.id}/uploads`, { name, size, type: 'application/pdf' }))).upload_id
  const at = (id: string) => `/api/sessions/${session.id}/uploads/${id}`
  expect((await c.post(`/api/sessions/${session.id}/uploads`, { name: 'photo.png', size: 10, type: 'image/png' })).status).toBe(415)
  // a chunk still arriving: another chunk and the completion wait their turn (409 with received); a cancel no longer
  // waits for a 409 — it stops the chunk and drops the upload (below: intended change of the 2026-10-14 integration)
  const id = await begin()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const slow = new ReadableStream<Uint8Array>({ async start(ctrl) { ctrl.enqueue(data.subarray(0, 100)); await gate; ctrl.enqueue(data.subarray(100, 200)); ctrl.close() } })
  const pending = raw('PUT', `${at(id)}?offset=0`, slow as unknown as Body)
  await Bun.sleep(30)
  expect((await raw('PUT', `${at(id)}?offset=0`, data.subarray(0, 10))).status).toBe(409)
  expect((await raw('POST', `${at(id)}/complete`)).status).toBe(409)
  release()
  expect(await json<Record<string, unknown>>(await pending)).toEqual({ received: 200 })
  // a chunk that breaks off is rolled back: the upload stands where the chunk began, and continues exactly
  const broken = new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.enqueue(data.subarray(200, 900)); ctrl.error(new Error('the connection dropped')) } })
  expect((await raw('PUT', `${at(id)}?offset=200`, broken as unknown as Body)).status).toBeGreaterThanOrEqual(400)
  expect((await json<{ received: number }>(await c.get(at(id)))).received).toBe(200)
  expect(statSync(join(state.settings.data_dir, 'uploads', `${id}.part`)).size).toBe(200)
  expect((await raw('PUT', `${at(id)}?offset=200`, Buffer.concat([data.subarray(200), Buffer.alloc(5)]))).status).toBe(413)   // more than it said
  expect((await json<{ received: number }>(await c.get(at(id)))).received).toBe(200)
  expect((await raw('PUT', `${at(id)}?offset=200`, data.subarray(200))).status).toBe(200)
  const assetsBefore = Number(state.conn.get('SELECT COUNT(*) AS n FROM assets')!.n)
  const done = await json<FileRefAttachment>(await raw('POST', `${at(id)}/complete`))
  expect(done.sha256).toBe(sha(data))                                                                  // the hash survived the rollback
  // the completion's answer lost on the way: asked again, the same reference — nothing new stored, no bytes again
  expect(await json<Record<string, unknown>>(await c.get(at(id)))).toEqual({ upload_id: id, received: data.length, size: data.length, completed: true })
  expect(await json<FileRefAttachment>(await raw('POST', `${at(id)}/complete`))).toEqual(done)
  expect(Number(state.conn.get('SELECT COUNT(*) AS n FROM assets')!.n)).toBe(assetsBefore + 1)
  expect((await raw('PUT', `${at(id)}?offset=0`, data.subarray(0, 10))).status).toBe(409)
  expect((await raw('DELETE', at(id))).status).toBe(409)                                              // a completed upload is not undone
  // another session never sees the completion
  const otherSession = await json<Session>(await c.post(`/api/projects/${session.project_id}/sessions`, { title: 'other' }))
  expect((await c.get(`/api/sessions/${otherSession.id}/uploads/${id}`)).status).toBe(404)
  expect((await raw('POST', `/api/sessions/${otherSession.id}/uploads/${id}/complete`)).status).toBe(404)
  // a cancel while a chunk is still arriving: the chunk is stopped and rolled back, the cancel waits for it, the upload
  // and its staged bytes go — no 409, no hang, no file left open
  const busyId = await begin()
  let hold!: () => void
  const held = new Promise<void>((r) => { hold = r })
  const stalled = new ReadableStream<Uint8Array>({ async start(ctrl) { ctrl.enqueue(data.subarray(0, 100)); await held; try { ctrl.enqueue(data.subarray(100, 200)); ctrl.close() } catch { /* cancelled */ } } })
  const stalledPut = raw('PUT', `${at(busyId)}?offset=0`, stalled as unknown as Body)
  await Bun.sleep(30)
  const cancelStarted = performance.now()
  expect(await json<Record<string, unknown>>(await raw('DELETE', at(busyId)))).toEqual({ deleted: true })
  expect(performance.now() - cancelStarted).toBeLessThan(5_000)
  hold()
  expect((await stalledPut).status).toBe(410)
  expect((await c.get(at(busyId))).status).toBe(404)
  expect(existsSync(join(state.settings.data_dir, 'uploads', `${busyId}.part`))).toBe(false)
  // cancel: the staged bytes go with it
  const gone = await begin()
  expect((await raw('PUT', `${at(gone)}?offset=0`, data.subarray(0, 50))).status).toBe(200)
  expect(existsSync(join(state.settings.data_dir, 'uploads', `${gone}.part`))).toBe(true)
  expect(await json<Record<string, unknown>>(await raw('DELETE', at(gone)))).toEqual({ deleted: true })
  expect(existsSync(join(state.settings.data_dir, 'uploads', `${gone}.part`))).toBe(false)
  expect((await c.get(at(gone))).status).toBe(404)
  // a completion whose bytes are not what the name says: refused, nothing kept
  const wrong = await begin(10, 'fake.pdf')
  await raw('PUT', `${at(wrong)}?offset=0`, Buffer.from('not a pdf!'))
  expect((await raw('POST', `${at(wrong)}/complete`)).status).toBe(415)
  expect(readdirSync(join(state.settings.data_dir, 'uploads'))).toEqual([])
  // a restart: the staging folder is emptied, an old upload id is a 404 (the client starts again)
  const left = await begin()
  await raw('PUT', `${at(left)}?offset=0`, data.subarray(0, 64))
  const restarted = new Uploads(state.settings.data_dir)
  expect(readdirSync(restarted.dir)).toEqual([])
  expect(() => restarted.get(session, left)).toThrow('does not outlive a restart')
  await restarted.close()
  // an idle upload is dropped at the next start
  let now = 1_000_000
  const clock = new Uploads(tempDir('oasis-idle-'), () => now)
  await clock.start(session, { name: 'a.pdf', size: 5, type: '' })
  expect(clock.open).toBe(1)
  now += UPLOAD_IDLE_MS + 1
  await clock.start(session, { name: 'b.pdf', size: 5, type: '' })
  expect(clock.open).toBe(1)
  await clock.close()
  expect(clock.open).toBe(0)
  expect(readdirSync(clock.dir)).toEqual([])
})

test('the attachment budget is judged early; the complete wire request (system, tools, history, encoded files) only at the last check before sending — a PDF that passes the first can be stopped by the second, and then nothing is fetched', async () => {
  const limits = PROVIDER_REQUEST_LIMITS.anthropic
  // a PDF just under what the attachment budget admits on Anthropic (its base64 under 32,000,000)
  const bytes = 23_900_000
  expect(nativeTotalRefusal(limits, [{ bytes, input_file: true }], 'anthropic')).toBeNull()
  const data = Buffer.alloc(bytes).toString('base64')
  let fetched = 0
  const body = { system: 's'.repeat(1_000_000), tools: [], messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }] }] }
  await expect(postJson('https://api.anthropic.com/v1/messages', body, {}, 'fixture', { requestProtocol: 'anthropic', maxRetries: 0, fetchImpl: async () => { fetched++; return new Response('{}') } }))
    .rejects.toThrow(/complete provider request is \d+ bytes; cap 32000000 bytes/)
  expect(fetched).toBe(0)
  // the same file without the long system text goes
  const small = { ...body, system: 's' }
  await postJson('https://api.anthropic.com/v1/messages', small, {}, 'fixture', { requestProtocol: 'anthropic', maxRetries: 0, fetchImpl: async () => { fetched++; return new Response('{}') } })
  expect(fetched).toBe(1)
})

test('a cancel is bounded as a whole: a body whose own cancel never settles does not hold it, and a chunk that has not stopped within the bound is never said dropped nor closed under its write', async () => {
  const session = { id: 's_cancel', project_id: 'p_cancel' } as Session
  const uploads = new Uploads(tempDir('oasis-cancel-'), Date.now, 150)
  // 1. a body that gives 5 bytes, then neither delivers more nor settles its cancel
  const entry = await uploads.start(session, { name: 'a.mp4', size: 100, type: 'video/mp4' })
  let cancelAsked = 0
  let first = true
  const stuck = new ReadableStream<Uint8Array>({
    pull(c) { if (first) { first = false; c.enqueue(new Uint8Array(5).fill(7)); return } return new Promise<void>(() => undefined) },
    cancel() { cancelAsked++; return new Promise<void>(() => undefined) },
  }, { highWaterMark: 0 })
  const chunk = uploads.turn(entry, 'chunk', () => entry.staged.append(stuck, 64, 100)).then(() => 'taken', (e: Error) => e.name)
  await new Promise((r) => setTimeout(r, 20))
  expect(entry.active).not.toBeNull()
  const began = Date.now()
  expect(await uploads.cancel(entry)).toBeNull()                       // settled, rolled back and dropped
  expect(Date.now() - began).toBeLessThan(1_000)
  expect(cancelAsked).toBe(1)
  expect(await chunk).toBe('StagedUploadBroken')
  expect(existsSync(entry.staged.path)).toBe(false)
  expect(uploads.open).toBe(0)
  // 2. a chunk whose turn has not settled within the bound (a write that hangs): pending, not dropped, still open
  const slow = await uploads.start(session, { name: 'b.mp4', size: 100, type: 'video/mp4' })
  let release!: () => void
  const writing = uploads.turn(slow, 'chunk', () => new Promise<number>((r) => { release = () => r(0) }))
  const err = await uploads.cancel(slow).then(() => null, (e: Error) => e)
  expect(err?.name).toBe('UploadCancelPending')
  expect(uploads.open).toBe(1)                                          // not said dropped
  expect(existsSync(slow.staged.path)).toBe(true)                       // not closed or removed under the write
  expect(slow.cancelling).toBe(true)
  // asked again, still bounded and still pending while the write goes on
  expect((await uploads.cancel(slow).then(() => null, (e: Error) => e))?.name).toBe('UploadCancelPending')
  release()
  await writing
  expect(await uploads.cancel(slow)).toBeNull()                         // the same cleanup, now done
  expect(existsSync(slow.staged.path)).toBe(false)
  expect(uploads.open).toBe(0)
  await uploads.close()
})

test("a session's commands are granted exactly its sent upload references (the sandbox applies them); never another session's, never an unsent one, never a local one", async () => {
  const { session, chat, c, local } = await setup()
  const state = app!.state
  const put = async (name: string, bytes: Buffer, sid = session.id) => json<FileRefAttachment>(await Promise.resolve(app!.app.request(`http://localhost/api/sessions/${sid}/attachments?name=${name}`, { method: 'POST', body: bytes, headers: { ...c.headers, 'content-type': 'application/pdf' } })))
  const sent = await put('sent.pdf', pdfFixture('sent'))
  await put('unsent.pdf', pdfFixture('unsent'))
  const mine = await json<FileRefAttachment>(await local(fileAt('mine.pdf', pdfFixture('local'))))
  const run = await json(await chat({ text: 'read them', model: 'scripted:b', attachments: [sent.asset_id, mine.asset_id] }))
  await waitDone(state, String(run.id))
  const other = await json<Session>(await c.post(`/api/projects/${session.project_id}/sessions`, { title: 'other' }))
  const theirs = await put('theirs.pdf', pdfFixture('theirs'), other.id)
  const theirRun = await json(await c.post(`/api/sessions/${other.id}/chat`, { text: 'x', model: 'scripted:b', attachments: [theirs.asset_id] }))
  await waitDone(state, String(theirRun.id))
  expect(sessionAttachmentReads(state.conn, state.store, session)).toEqual([{ asset_id: sent.asset_id, path: sent.location }])
  expect(sessionAttachmentReads(state.conn, state.store, other)).toEqual([{ asset_id: theirs.asset_id, path: theirs.location }])
  // a record tampered with (its location pointed elsewhere) grants nothing
  const asset = repo.getAsset(state.conn, sent.asset_id)!
  repo.setAssetMeta(state.conn, sent.asset_id, { ...asset.meta, ref: { ...(asset.meta.ref as object), location: '/etc/passwd' } })
  expect(sessionAttachmentReads(state.conn, state.store, session)).toEqual([])
})

test("a grant is judged against the reference as it was sent: a record rewritten afterwards — even consistently, to another stored upload's path and name — grants nothing, says why, and leaves the history as it was", async () => {
  const { session, chat, c } = await setup()
  const state = app!.state
  const put = async (name: string, bytes: Buffer) => json<FileRefAttachment>(await Promise.resolve(app!.app.request(`http://localhost/api/sessions/${session.id}/attachments?name=${name}`, { method: 'POST', body: bytes, headers: { ...c.headers, 'content-type': 'application/pdf' } })))
  const sent = await put('sent.pdf', pdfFixture('sent-frozen'))
  const decoy = await put('decoy.pdf', pdfFixture('decoy-never-sent'))
  const run = await json(await chat({ text: 'read it', model: 'scripted:b', attachments: [sent.asset_id] }))
  await waitDone(state, String(run.id))
  expect(sessionAttachmentReads(state.conn, state.store, session)).toEqual([{ asset_id: sent.asset_id, path: sent.location }])
  const historyBefore = (state.conn.get('SELECT attachments_json AS a FROM runs WHERE id = ?', [String(run.id)]) as { a: string }).a
  // the sent asset's row rewritten to stand, self-consistently, for the never-sent upload: its location, name, hash
  // and storage path all agree with each other — only the reference frozen on the message says otherwise
  const row = repo.getAsset(state.conn, sent.asset_id)!
  const other = repo.getAsset(state.conn, decoy.asset_id)!
  repo.setAssetMeta(state.conn, sent.asset_id, { ...row.meta, ref: { ...(row.meta.ref as object), name: 'decoy.pdf', location: decoy.location, sha256: decoy.sha256, bytes: decoy.bytes } })
  state.conn.run('UPDATE assets SET storage_path = ?, sha256 = ?, byte_size = ? WHERE id = ?', [other.storage_path, other.sha256, other.byte_size, sent.asset_id])
  expect(repo.getAsset(state.conn, sent.asset_id)!.storage_path).toBe(other.storage_path)
  // no grant, neither the new path nor the old
  expect(sessionAttachmentReads(state.conn, state.store, session)).toEqual([])
  const files = sessionInputFiles(state.conn, state.store, state.settings.data_dir, session)
  expect(files.paths).toEqual([])
  const why = files.refused.find((r) => r.asset_id === sent.asset_id)
  expect(why?.reason).toContain('does not match its record')
  expect(why?.reason).toContain('no longer agrees')
  expect(files.paths.includes(decoy.location)).toBe(false)
  // the history is append-only: the run still holds the reference exactly as it was sent
  expect((state.conn.get('SELECT attachments_json AS a FROM runs WHERE id = ?', [String(run.id)]) as { a: string }).a).toBe(historyBefore)
  expect(JSON.parse(historyBefore)[0]).toMatchObject({ asset_id: sent.asset_id, name: 'sent.pdf', location: sent.location })
})

test('provider serializers: a native reference is Anthropic\'s document and Gemini\'s inlineData; a tool return carrying one is refused', async () => {
  const { session, local } = await setup()
  const state = app!.state
  const clip = mp4Fixture()
  const video = await json<FileRefAttachment>(await local(fileAt('clip.mp4', clip)))
  const doc = await json<FileRefAttachment>(await local(fileAt('doc.pdf', pdfFixture('serialized'))))
  expect(isFileRefAttachment(video) && isFileRefAttachment(doc)).toBe(true)
  const refs = refsOf(state, session)
  const read = attachmentReader((id) => repo.getAsset(state.conn, id), (p) => state.store.read(p), session.project_id, session.id)
  const bodies: string[] = []
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response('{}', { status: 500 }) }
  const params = { function_tools: [], allow_text_output: true, thinking: null }
  const anthropic = new AnthropicModel('fixture', { apiKey: 'synthetic', baseUrl: 'http://fixture.invalid', maxRetries: 0, fetchImpl })
  await anthropic.request(hydrateAttachments(history(doc), read, { pdf: true }, 'a', null, { limits: PROVIDER_REQUEST_LIMITS.anthropic, refs }), {}, params).catch(() => undefined)
  expect(bodies.at(-1)).toContain('"type":"document"')
  expect(bodies.at(-1)).toContain(pdfFixture('serialized').toString('base64'))
  const gemini = new GoogleModel('gemini-3.6-flash', { apiKey: 'synthetic', baseUrl: 'http://fixture.invalid', maxRetries: 0, fetchImpl })
  await gemini.request(hydrateAttachments(history(video), read, { video: GEMINI_VIDEO }, 'g', null, { limits: PROVIDER_REQUEST_LIMITS.google, refs }), {}, params).catch(() => undefined)
  expect(bodies.at(-1)).toContain('"inlineData":{"mimeType":"video/mp4"')
  expect(bodies.at(-1)).toContain(Buffer.from(clip).toString('base64'))
  const { toolReturn } = await import('../src/llm/messages.ts')
  const inTool = [modelRequest([userPrompt('read')]), modelRequest([toolReturn('read_file', { status: 'ok', file: attachmentPiece(doc) }, 'c1')])]
  expect(() => hydrateAttachments(inTool, read, { pdf: true }, 'a', null, { limits: PROVIDER_REQUEST_LIMITS.anthropic, refs })).toThrow('tool results are not supported')
})

test('a reference is never refused by a route for its kind (it is named by its path), and carries a file_kind the ChatGPT web runner refuses before reading', async () => {
  const { local } = await setup()
  const doc = await json<FileRefAttachment>(await local(fileAt('web.pdf', pdfFixture())))
  const { attachmentRefusal } = await import('@oasis-code/contract')
  expect(attachmentRefusal({ images: false }, [doc], 'b')).toBeNull()
  expect('file_kind' in doc).toBe(true)                    // runner.executeChatGpt: `'file_kind' in image` → refused, unread
})
