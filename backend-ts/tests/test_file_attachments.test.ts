import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachmentRefusal, nativeAttachment, DirectorSayBodySchema, FILE_LIMITS, type Attachment, type FileAttachment, type Session } from '@oasis-code/contract'
import { DEFAULT_MODELS, ModelConfig, ModelConfigSchema } from '../src/config.ts'
import { measureAttachment, decodeText } from '../src/llm/files.ts'
import { attachmentPiece, attachmentReader, AttachmentHydration, hydrateAttachments, isFilePiece, type AttachmentPlacer } from '../src/llm/attachments.ts'
import { legacyPlacementPath } from '../src/workspace/legacy_attachment_placer.ts'
import { assertRequestSize, MAX_PROVIDER_REQUEST_BYTES, postJson } from '../src/llm/http.ts'
import { modelRequest, modelResponse, textPart, userPrompt, toolReturn, type ModelMessage } from '../src/llm/messages.ts'
import { AnthropicModel, GoogleModel, OpenAIChatModel, OpenAIResponsesModel } from '../src/llm/providers.ts'
import { Agent } from '../src/agent/loop.ts'
import { sha256Hex } from '../src/store.ts'
import { readBounded } from '../src/api/attachments.ts'
import { createApp, type App } from '../src/main.ts'
import * as repo from '../src/db/repo.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, FAKE_FULL, PassthroughRuntime, scriptedModel, setModel, testConfig, testSettings, waitDone } from './harness.ts'
import { Route, runAgent, tempDir } from './helpers.ts'
import { anthropicResponses, geminiResponses, openaiResponses } from './providers_fixtures.ts'
import { pdfFixture, mp4Fixture, webmFixture } from './file_fixtures.ts'
const pdf = pdfFixture(), text = Buffer.from('\ufeff# exact UTF-8\r\n你好\n')
const caps = { images: true, pdf: true, video: ['video/mp4', 'video/webm', 'video/quicktime'] }
const reference = (bytes: Uint8Array, name: string): FileAttachment => ({ asset_id: 'a_file', bytes: bytes.length, sha256: sha256Hex(bytes), name, ...measureAttachment(bytes, name) }) as FileAttachment
const pdfRef = reference(pdf, 'proof.pdf'), textRef = reference(text, 'notes.md')
const history = (ref: Attachment) => [modelRequest([userPrompt(['look', attachmentPiece(ref)])])]

test('formats are measured, not trusted: UTF-8, PDF structure/encryption, video tracks and container bounds', () => {
  expect(decodeText(text)).toBe('\ufeff# exact UTF-8\r\n你好\n')
  for (const [bytes, name, mime] of [[pdf, 'proof.pdf', 'application/pdf'], [mp4Fixture(), 'clip.mp4', 'video/mp4'], [mp4Fixture('qt  '), 'clip.mov', 'video/quicktime'], [webmFixture(), 'clip.webm', 'video/webm']] as const) expect(measureAttachment(bytes, name).media_type).toBe(mime)
  for (const [bytes, name, mime] of [
    [Buffer.from([0xc0, 0x80]), 'notes.md', ''], [Buffer.from('a\0b'), 'notes.txt', ''], [Buffer.from('a\x1bb'), 'a.ts', ''], [Buffer.from('PK\x03\x04zip'), 'a.md', ''],
    [pdf, 'a.txt', ''], [pdf, 'a.pdf', 'video/mp4'], [Buffer.from('not a PDF'), 'a.pdf', 'application/pdf'], [pdf.subarray(0, -12), 'a.pdf', ''],
    [Buffer.from(pdf.toString().replace('/Size 6', '/Encrypt 6 0 R /Size 6')), 'a.pdf', ''], [mp4Fixture('isom', 'soun'), 'a.mp4', ''],
    [mp4Fixture().subarray(0, -1), 'a.mp4', ''], [webmFixture(2), 'a.webm', ''], [webmFixture().subarray(0, -1), 'a.webm', ''],
    [Buffer.from('hello'), 'a.docx', ''], [Buffer.from('<svg/>'), 'a.svg', 'image/svg+xml'],
  ] as const) expect(() => measureAttachment(bytes, name, mime), name).toThrow()
  expect(measureAttachment(Buffer.alloc(FILE_LIMITS.text, 0x61), 'a.md').media_type).toBe('text/plain')
  expect(() => measureAttachment(Buffer.alloc(FILE_LIMITS.text + 1, 0x61), 'a.md')).toThrow('1 MiB')
  expect(() => measureAttachment(Buffer.alloc(FILE_LIMITS.pdf + 1), 'a.pdf')).toThrow('20 MiB')
  expect(measureAttachment(text, 'notes.md', 'text/markdown; charset=utf-8').media_type).toBe('text/plain')
})

test('bounded streams reject declared oversize before reading and cancel chunked overflow', async () => {
  let pulled = 0, cancelled = 0
  const stream = () => new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(6)) }, cancel() { cancelled++ } }, { highWaterMark: 0 })
  await expect(readBounded(new Request('http://localhost', { method: 'POST', body: stream(), headers: { 'content-length': '11' } }), 10)).rejects.toThrow('exceeds')
  expect(pulled).toBe(0); expect(cancelled).toBe(1)
  await expect(readBounded(new Request('http://localhost', { method: 'POST', body: stream() }), 10)).rejects.toThrow('exceeds')
  expect(pulled).toBe(2); expect(cancelled).toBe(2)
})

test('every default route: a PDF or a video is never refused (taken itself, or saved for the tools); which take them natively; text independent of images', () => {
  expect(DEFAULT_MODELS).toHaveLength(21)
  const video = reference(mp4Fixture(), 'v.mp4')
  for (const raw of DEFAULT_MODELS) {
    const route = new ModelConfig(ModelConfigSchema.parse(raw))
    expect(attachmentRefusal(route.capabilities, [textRef], route.id)).toBeNull()
    expect(attachmentRefusal(route.capabilities, [pdfRef, video], route.id)).toBeNull()
    // the subscription routes answered a PDF probe (2026-10-13); the DeepSeek and BigModel standard APIs take none: saved for the tools
    expect(nativeAttachment(route.capabilities, pdfRef)).toBe(route.provider !== 'deepseek' && route.provider !== 'zhipu')
    expect(nativeAttachment(route.capabilities, video)).toBe(route.id === 'google:gemini-4-argon')
    expect(route.capability_source).not.toContain('verified')
  }
  expect(attachmentRefusal({ images: false }, [textRef], 'text route')).toBeNull()
  expect(attachmentRefusal({ images: true }, [pdfRef], 'no PDF route')).toBeNull()
  expect(attachmentRefusal({ images: false }, [{ media_type: 'image/png', name: 'red.png' }], 'no image route')).toContain('not configured to take images')
  expect(DirectorSayBodySchema.safeParse({ text: 'do not send alone', attachments: ['a_file'] }).success).toBe(true)
})

test('canonical history is byte-stable across hydration, append, retry and incompatible model switches', () => {
  const canonical = history(textRef), before = JSON.stringify(canonical)
  const first = hydrateAttachments(canonical, () => text, {}, 'a')
  expect(JSON.stringify(first)).toContain('attached UTF-8 file v1')
  expect(hydrateAttachments(canonical, () => text, { images: false }, 'b')).toEqual(first)
  expect(JSON.stringify(canonical)).toBe(before)
  expect(() => hydrateAttachments(canonical, () => null, {}, 'a')).toThrow('missing')
  expect(() => hydrateAttachments(canonical, () => Buffer.from('changed'), {}, 'a')).toThrow('damaged')
  // a PDF the route does not take: saved where the run's tools reach it, the request naming where — the same words
  // on every request; with no such folder, nothing is sent
  expect(() => hydrateAttachments(history(pdfRef), () => pdf, { images: true }, 'no-pdf')).toThrow('no folder to keep it in')
  const dir = join(tempDir('oasis-placed-'), 'attachments')
  const withPdf = history(pdfRef)
  // a test placer (the app's own is workspace/legacy_attachment_placer.ts, a confined writer covered in
  // test_legacy_attachment_placer): the legacy path, its bytes loaded only when it places the file — once
  let loads = 0
  const placedOnce = new Set<string>()
  const testPlacer: AttachmentPlacer = (file, load) => {
    const path = legacyPlacementPath(dir, file)
    if (!placedOnce.has(path)) { placedOnce.add(path); loads += 1; mkdirSync(dir, { recursive: true }); writeFileSync(path, load()) }
    return path
  }
  const placed = JSON.stringify(hydrateAttachments(withPdf, () => pdf, { images: true }, 'no-pdf', testPlacer))
  const path = join(dir, `${pdfRef.sha256.slice(0, 12)}-proof.pdf`)
  expect(placed).toContain(`application/pdf; ${pdf.length} bytes; this model does not take it directly; saved at ${path}`)
  expect(placed).not.toContain(pdf.toString('base64'))
  expect(existsSync(path) && readFileSync(path).equals(pdf)).toBe(true)
  // a later request: the same words, nothing read again (the reader would fail now)
  expect(JSON.stringify(hydrateAttachments(withPdf, () => null, { images: true }, 'no-pdf', testPlacer))).toBe(placed)
  expect(loads).toBe(1)
  const appended = [...canonical, modelResponse([textPart('done')]), modelRequest([userPrompt('next')])]
  hydrateAttachments(appended, () => text, {}, 'a')
  expect(JSON.stringify(appended[0])).toBe(JSON.stringify(canonical[0]))
  expect(isFilePiece(attachmentPiece(textRef))).toBe(true)
})

const chatBody = 'data: {"id":"c","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
test('four real provider serializers: native PDF and exact text envelope; video positive/negative and tool-result refusal', async () => {
  const agent = new Agent<null>({ instructions: 'x', tools: [] })
  for (const protocol of ['anthropic', 'responses', 'chat', 'google'] as const) {
    const route = new Route(protocol === 'anthropic' ? anthropicResponses().slice(-1) : protocol === 'responses' ? openaiResponses().slice(-1) : protocol === 'google' ? geminiResponses().slice(-1) : [chatBody])
    const opts = { apiKey: 'synthetic', baseUrl: 'http://fixture.invalid', fetchImpl: route.fetch }
    const model = protocol === 'anthropic' ? new AnthropicModel('claude-fixture', opts) : protocol === 'responses' ? new OpenAIResponsesModel('gpt-fixture', opts) : protocol === 'chat' ? new OpenAIChatModel('gpt-fixture', opts) : new GoogleModel('gemini-3.6-flash', opts)
    await runAgent(agent, new AttachmentHydration(model, (r) => r.media_type === 'application/pdf' ? pdf : text, caps), ['look', attachmentPiece(textRef), attachmentPiece(pdfRef)], null)
    const request = route.requests[0]!, b64 = pdf.toString('base64')
    const serialized = JSON.stringify(request)
    expect(serialized).toContain('attached UTF-8 file v1')
    expect(serialized).toContain('你好')
    if (protocol === 'anthropic') expect(serialized).toContain(JSON.stringify({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }))
    if (protocol === 'responses') expect(serialized).toContain(JSON.stringify({ type: 'input_file', filename: 'proof.pdf', file_data: `data:application/pdf;base64,${b64}` }))
    if (protocol === 'chat') expect(serialized).toContain(JSON.stringify({ type: 'file', file: { filename: 'proof.pdf', file_data: `data:application/pdf;base64,${b64}` } }))
    if (protocol === 'google') expect(serialized).toContain(JSON.stringify({ inlineData: { mimeType: 'application/pdf', data: b64 } }))
    const video = mp4Fixture('qt  '), prompt = [attachmentPiece(reference(video, 'clip.mov'))]
    if (protocol === 'google') {
      await runAgent(agent, new AttachmentHydration(model, () => video, caps), prompt, null)
      expect(JSON.stringify(route.requests.at(-1))).toContain('"mimeType":"video/mov"')
    } else await expect(runAgent(agent, new AttachmentHydration(model, () => video, caps), prompt, null)).rejects.toThrow('does not support native')
    expect(() => hydrateAttachments([modelRequest([toolReturn('read_file', { file: attachmentPiece(pdfRef) }, 'c')])], () => pdf, caps, protocol)).toThrow('tool results')
  }
})

test('entire wire JSON is bounded after base64 and beforeSend, without making a request', async () => {
  assertRequestSize('x'.repeat(MAX_PROVIDER_REQUEST_BYTES))
  expect(() => assertRequestSize('你'.repeat(Math.ceil(MAX_PROVIDER_REQUEST_BYTES / 3) + 1))).toThrow('complete provider request')
  let called = false
  await expect(postJson('http://fixture.invalid', {}, {}, 'fixture', { beforeSend(req) { req.body = 'x'.repeat(MAX_PROVIDER_REQUEST_BYTES + 1) }, fetchImpl: async () => { called = true; return new Response('ok') } })).rejects.toThrow()
  expect(called).toBe(false)
})

let app: App | null = null
afterEach(async () => { await app?.close(); app = null })
async function setup(opts: { full?: boolean } = {}) {
  const config = testConfig()
  config.models = [new ModelConfig({ id: 'scripted:a', provider: 'anthropic', model: 'scripted-a', capabilities: caps }), new ModelConfig({ id: 'scripted:b', provider: 'openai', model: 'scripted-b', capabilities: { images: false } })]
  // full: the passthrough runtime under a full report (the mechanics of a confined helper, not the OS confinement)
  app = await createApp(testSettings(), config, opts.full ? { runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } } : { probe: false })
  for (const id of ['scripted:a', 'scripted:b']) setModel(app.state, id, scriptedModel(() => modelResponse([textPart('fixture done')])))
  const c = new Client(app), source = buggyRepo()
  const project = await json(await c.post('/api/projects', { source_path: source }))
  const session = await json<Session>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'files' }))
  const upload = (name: string, bytes: Uint8Array, mime = '') => c.app.app.request(`http://localhost/api/sessions/${session.id}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes, headers: { ...c.headers, 'content-type': mime || 'application/octet-stream' } })
  return { c, session, upload, source }
}

test('API to runner to append-only history: attachment-only, mixed, replay gate, corrupt asset and safe downloads', async () => {
  const { c, session, upload } = await setup()
  let handed: ModelMessage[] = []
  const model = scriptedModel((messages) => { handed = messages; return modelResponse([textPart('read')]) })
  setModel(app!.state, 'scripted:a', model); setModel(app!.state, 'scripted:b', model)
  const note = await json<Attachment>(await upload('notes.md', text, 'text/markdown'))
  const doc = await json<Attachment>(await upload('proof.pdf', pdf))
  const image = await json<Attachment>(await upload('image.png', readFileSync(join(import.meta.dir, 'fixtures/images/red-7x5.png'))))
  const chat = (body: object) => c.post(`/api/sessions/${session.id}/chat`, body)
  const a = await json(await chat({ text: '', model: 'scripted:b', attachments: [note.asset_id] }))
  expect((await waitDone(app!.state, a.id as string)).status).toBe('done')
  expect(JSON.stringify(handed)).toContain('attached UTF-8 file v1')
  const first = repo.getRunHistory(app!.state.conn, a.id as string)!
  expect(first).not.toContain('exact UTF-8')
  const b = await json(await chat({ text: 'mixed', model: 'scripted:a', attachments: [doc.asset_id, image.asset_id] }))
  expect((await waitDone(app!.state, b.id as string)).status).toBe('done')
  expect(JSON.parse(repo.getRunHistory(app!.state.conn, b.id as string)!).slice(0, JSON.parse(first).length)).toEqual(JSON.parse(first))
  expect(repo.getRunHistory(app!.state.conn, a.id as string)).toBe(first)
  // the replay gate: a route that cannot take the history's image is refused; its PDF would only be saved for the tools
  const rejected = await chat({ text: 'switch with an existing image and PDF', model: 'scripted:b' })
  expect(rejected.status).toBe(400)
  const why = JSON.stringify(await rejected.json())
  expect(why).toContain('not configured to take images: image.png')
  expect(why).not.toContain('PDF')
  expect((await chat({ text: 'duplicate', attachments: [doc.asset_id, doc.asset_id] })).status).toBe(400)
  expect((await chat({ text: '', attachments: Array(9).fill(doc.asset_id) })).status).toBe(422)
  const download = await c.get(`/api/sessions/${session.id}/attachments/${note.asset_id}`)
  expect(download.headers.get('content-disposition')).toContain('attachment;')
  expect(download.headers.get('content-security-policy')).toContain('sandbox')
  expect(Buffer.from(await download.arrayBuffer())).toEqual(text)
  const other = await json<Session>(await c.post(`/api/projects/${session.project_id}/sessions`, { title: 'other' }))
  expect((await c.get(`/api/sessions/${other.id}/attachments/${note.asset_id}`)).status).toBe(404)
  const asset = repo.getAsset(app!.state.conn, note.asset_id)!
  const read = attachmentReader((id) => repo.getAsset(app!.state.conn, id), (path) => app!.state.store.read(path), session.project_id, session.id)
  expect(read({ ...note, bytes: note.bytes + 1 })).toBeNull()
  expect(attachmentReader(() => ({ ...asset, storage_path: '../escape' }), () => text, session.project_id, session.id)(note)).toBeNull()
  expect(attachmentReader(() => ({ ...asset, kind: 'report' }), () => text, session.project_id, session.id)(note)).toBeNull()
  writeFileSync(app!.state.store.abspath(asset.storage_path), 'changed')
  expect((await c.get(`/api/sessions/${session.id}/attachments/${note.asset_id}`)).status).toBe(409)
  expect((await chat({ text: 'replay damaged' })).status).toBe(400)
})

test('review regressions: prose magic, real trailers/xref streams, compatible brands and unknown WebM Clusters', async () => {
  const { xrefStreamPdf, webmClustersFixture } = await import('./file_fixtures.ts')
  for (const content of ['PKCE flow\nUse a code verifier...', 'RIFF is a container format.', 'ID3 tags are metadata.']) expect(measureAttachment(Buffer.from(content), 'notes.md').media_type).toBe('text/plain')
  expect(measureAttachment(pdfFixture('/Encrypt is a PDF dictionary key'), 'notes.pdf').media_type).toBe('application/pdf')
  const withTitle = Buffer.from(pdf.toString().replace('/Size 6', '/Title (Notes about /Encrypt) /Note <2f456e6372797074> /Nested << /Encrypt (not a trailer key) >> % /Encrypt commented\n/Size 6'))
  expect(measureAttachment(withTitle, 'title.pdf').media_type).toBe('application/pdf')
  expect(measureAttachment(xrefStreamPdf(), 'xref.pdf').media_type).toBe('application/pdf')
  expect(() => measureAttachment(Buffer.from(pdf.toString().replace('/Size 6', '/Encr#79pt 9 0 R /Size 6')), 'encrypted.pdf')).toThrow('encrypted')
  expect(() => measureAttachment(Buffer.from('%PDF-1.7\n1 0 obj\n<< /Root 1 0 R >>\nendobj\nstartxref\n9\n%%EOF\n'), 'fake.pdf')).toThrow('XRef')
  for (const brand of ['iso3', 'av01', 'xxxx']) expect(measureAttachment(mp4Fixture(brand), 'clip.mp4').media_type).toBe('video/mp4') // isom in compatible_brands
  for (const group of [false, true]) {
    const b = webmClustersFixture(group)
    expect(measureAttachment(b, 'clip.webm').media_type).toBe('video/webm')
    expect(() => measureAttachment(b.subarray(0, b.length - 2), 'cut.webm')).toThrow()
  }
  for (const [name, mime] of [['query.sql', 'application/sql'], ['run.sh', 'application/x-sh'], ['config.yaml', 'application/x-yaml']]) expect(measureAttachment(Buffer.from('value'), name, mime).media_type).toBe('text/plain')
})

test('long labels and Windows asset paths: upload, hydrate and ownership/traversal validation', async () => {
  const { upload, session } = await setup()
  const note = await json<Attachment>(await upload('a'.repeat(121) + '.md', text))
  expect(note.name.length).toBe(120); expect(note.name.endsWith('.md')).toBe(true)
  const asset = repo.getAsset(app!.state.conn, note.asset_id)!
  const windows = { ...asset, storage_path: asset.storage_path.replaceAll('/', '\\') }
  const reader = attachmentReader(() => windows, (path) => app!.state.store.read(path), session.project_id, session.id)
  expect(reader(note)).toEqual(text)
  expect(JSON.stringify(hydrateAttachments(history(note), reader, {}, 'text'))).toContain('exact UTF-8')
  for (const storage_path of ['..\\escape', 'C:\\escape', '\\\\host\\share', asset.storage_path.replace('/text/', '/text/../text/')]) expect(attachmentReader(() => ({ ...asset, storage_path }), () => text, session.project_id, session.id)(note)).toBeNull()
  expect(attachmentReader(() => windows, () => text, session.project_id, 's_other')(note)).toBeNull()
})

test('route request limits count all history/tools/base64 without imposing Anthropic limits on Codex or eight-image API requests', () => {
  const image = 'data:image/png;base64,' + Buffer.alloc(5 * 1024 * 1024).toString('base64')
  const eight = JSON.stringify({ input: Array.from({ length: 8 }, () => ({ type: 'input_image', image_url: image })), tools: [{ description: 'tool schema' }] })
  expect(Buffer.byteLength(eight)).toBeGreaterThan(55_000_000)
  expect(() => assertRequestSize(eight, { protocol: 'anthropic' })).toThrow('32000000')
  assertRequestSize(eight, { protocol: 'google' })
  assertRequestSize(eight, { protocol: 'openai', url: 'https://api.openai.com/v1/responses' })
  assertRequestSize(eight, { protocol: 'openai', url: 'https://chatgpt.com/backend-api/codex/responses' })
  const file = { type: 'input_file', file_data: 'data:application/pdf;base64,' + Buffer.alloc(20 * 1024 * 1024).toString('base64') }
  assertRequestSize(JSON.stringify({ input: [file, file] }), { protocol: 'openai' })
  const accumulated = JSON.stringify({ history: [file, file], input: [file] })
  expect(() => assertRequestSize(accumulated, { protocol: 'openai' })).toThrow('raw bytes')
  assertRequestSize(accumulated, { protocol: 'openai', url: 'https://chatgpt.com/backend-api/codex/responses' })
  assertRequestSize('x'.repeat(32_000_000), { protocol: 'anthropic' })
  expect(() => assertRequestSize('x'.repeat(32_000_001), { protocol: 'anthropic' })).toThrow('32000001')
  expect(() => assertRequestSize('x'.repeat(100_000_001), { protocol: 'google' })).toThrow('100000000')
})

// a legacy reference (native-v1, made before ref-v1 existed): an old history's video still reaches the run as a file
// in the workspace's temporary folder, in the same words. New uploads are ref-v1 (test_large_file_refs.test.ts). The
// file is placed by the app's confined placer (workspace/legacy_attachment_placer.ts), never by the harness writing
// into a folder its commands write: without full enforcement nothing is written, the words stay the same, and the run
// shows the refusal (an `attachment_refused` event). Updated at the 2026-10-14 integration: the baseline's unconfined
// folderPlacer wrote the file whatever the enforcement.
test("a legacy video reference the route does not take reaches the run as a file in its workspace's temporary folder, the request naming where", async () => {
  for (const full of [true, false]) {
    const { c, session } = await setup({ full })
    const handed: string[] = []
    setModel(app!.state, 'scripted:b', scriptedModel((messages) => { handed.push(JSON.stringify(messages)); return modelResponse([textPart('seen')]) }))
    const clip = mp4Fixture()
    const { legacyFileAttachment } = await import('./file_fixtures.ts')
    const video = await legacyFileAttachment(app!.state, session, clip, 'clip.mp4')
    expect((video as FileAttachment).representation).toBe('native-v1')
    const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'what is in the clip?', model: 'scripted:b', attachments: [video.asset_id] }))
    expect((await waitDone(app!.state, run.id as string)).status).toBe('done')
    const next = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'and again?', model: 'scripted:b' }))
    expect((await waitDone(app!.state, next.id as string)).status).toBe('done')
    const path = join(app!.state.processes.tempFor(session.workspace_id!, ''), 'attachments', `${(video as FileAttachment).sha256.slice(0, 12)}-clip.mp4`)
    const words = `video/mp4; ${clip.length} bytes; this model does not take it directly; saved at ${path}`
    expect(handed.length).toBeGreaterThanOrEqual(2)
    for (const h of handed) {
      expect(h).toContain(words)                                                                     // the same words, every request
      expect(h).not.toContain(Buffer.from(clip).toString('base64'))
    }
    expect(repo.getRunHistory(app!.state.conn, run.id as string)).not.toContain('saved at')        // the record keeps the reference, not the words
    const refusals = [run.id, next.id].flatMap((id) => repo.listEvents(app!.state.conn, id as string).filter((e) => e.event === 'attachment_refused'))
    if (full) {
      expect(readFileSync(path).equals(Buffer.from(clip))).toBe(true)
      expect(refusals).toEqual([])
    } else {
      expect(existsSync(path)).toBe(false)                                                           // fail closed: nothing written
      expect(refusals.length).toBeGreaterThanOrEqual(1)
      expect(refusals[0]!.data).toMatchObject({ scope: 'placement', path, name: 'clip.mp4' })
      expect(String(refusals[0]!.data.reason)).toContain('not fully enforced')
    }
    await app!.close(); app = null
  }
})

test('read_file refuses native files with a useful explanation; relay/interaction plans share attachment gates', async () => {
  const { session } = await setup()
  const { toolCallPart, lastToolReturn } = await import('../src/llm/messages.ts')
  const ws = repo.getWorkspace(app!.state.conn, session.workspace_id!)!
  writeFileSync(join(ws.path, 'proof.pdf'), pdf)
  let result: unknown = null
  setModel(app!.state, 'scripted:a', scriptedModel((messages) => {
    result = lastToolReturn(messages, 'read_file')
    return result ? modelResponse([textPart('refusal recorded')]) : modelResponse([toolCallPart('read_file', { path: 'proof.pdf' }, 'read-native')])
  }))
  const run = await app!.state.runs.start(session, 'read proof.pdf')
  expect((await waitDone(app!.state, run.id)).status).toBe('done')
  expect(JSON.stringify(result)).toContain('read_file returns text and images; proof.pdf is a PDF or video file')
  const agents = [{ model: 'scripted:a' }, { model: 'scripted:b' }]
  // a PDF goes to every participant (taken itself, or saved for its tools); an image to one that cannot take it does not
  expect(app!.state.relays.plan(agents, 1, [pdfRef])).toBeDefined()
  expect(app!.state.interactions.plan(agents, [pdfRef])).toHaveLength(2)
  const imageRef = { asset_id: 'a_image', media_type: 'image/png', name: 'red.png', bytes: 1, sha256: '0'.repeat(64), width: 1, height: 1 } as never
  expect(() => app!.state.relays.plan(agents, 1, [imageRef])).toThrow('not configured to take images')
  expect(() => app!.state.interactions.plan(agents, [imageRef])).toThrow('not configured to take images')
  expect(app!.state.relays.plan(agents, 1, [textRef])).toBeDefined()
  expect(app!.state.interactions.plan(agents, [textRef])).toHaveLength(2)
})

test('PDF token comments/NUL, filter parameter arrays, bounded PNG predictor rows, hybrid supplement then Prev', async () => {
  const { deflateSync } = await import('node:zlib')
  const { xrefStreamPdf, hybridPdfFixture } = await import('./file_fixtures.ts')
  const spaced = Buffer.from(pdf.toString().replace('/Root 1 0 R', '/Root 1 % comment\n0 R').replace('/Pages 2 0 R', '/Pages 2\0 0 R'))
  // The Pages substitution above lengthens object 1: rebuild its classic xref offsets instead of using a broken PDF.
  let plain = spaced.toString('latin1'), at = plain.indexOf('xref\n')
  const offsets = [1, 2, 3, 4, 5].map((id) => plain.indexOf(`${id} 0 obj`))
  plain = plain.slice(0, at) + `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 % comment\n0 R >>\nstartxref\n${at}\n%%EOF\n`
  expect(measureAttachment(Buffer.from(plain, 'latin1'), 'spaced.pdf').media_type).toBe('application/pdf')
  const xref = xrefStreamPdf(), start = Number(/startxref\s+(\d+)/.exec(xref.toString('latin1'))![1])
  const first = xref.indexOf('stream\n', start) + 7, entries = xref.subarray(first, first + 49)
  const variant = (raw: Buffer, filter: string, params: string, compress = true) => {
    const data = compress ? deflateSync(raw) : raw
    return Buffer.concat([xref.subarray(0, start), Buffer.from(`6 0 obj\n<< /Type /XRef /Size 7 /Root 1 0 R /W [1 4 2] /Length ${data.length} ${filter} ${params} >>\nstream\n`), data,
      Buffer.from(`\nendstream\nendobj\nstartxref\n${start}\n%%EOF\n`)])
  }
  for (const [filter, params, compressed] of [['', '', false], ['/Filter /FlateDecode', '', true], ['/Filter [/FlateDecode]', '/DecodeParms [null]', true], ['/Filter [/FlateDecode]', '/DecodeParms [<< /Predictor 1 >>]', true]] as const) expect(measureAttachment(variant(entries, filter, params, compressed), 'xref.pdf').media_type).toBe('application/pdf')
  const encoded = (predictor: number) => {
    const rows: Buffer[] = []
    for (let row = 0; row < 7; row++) {
      const type = predictor === 15 ? row % 5 : predictor - 10, line = Buffer.alloc(8); line[0] = type
      for (let col = 0; col < 7; col++) {
        const a = col ? entries[row * 7 + col - 1]! : 0, b = row ? entries[(row - 1) * 7 + col]! : 0, c = row && col ? entries[(row - 1) * 7 + col - 1]! : 0
        const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
        const paeth = [a, b, c][distances.indexOf(Math.min(...distances))]!
        const prediction = [0, a, b, Math.floor((a + b) / 2), paeth][type]!
        line[col + 1] = (entries[row * 7 + col]! - prediction + 256) & 255
      }
      rows.push(line)
    }
    return Buffer.concat(rows)
  }
  for (const predictor of [10, 11, 12, 13, 14, 15]) expect(measureAttachment(variant(encoded(predictor), '/Filter [/FlateDecode]', `/DecodeParms [<< /Predictor ${predictor} /Columns 7 >>]`), 'predict.pdf').media_type).toBe('application/pdf')
  const params = '/DecodeParms << /Predictor 12 /Columns 7 >>'
  expect(() => measureAttachment(variant(encoded(12).subarray(0, -1), '/Filter /FlateDecode', params), 'truncated.pdf')).toThrow('rows')
  const illegal = encoded(12); illegal[0] = 5
  expect(() => measureAttachment(variant(illegal, '/Filter /FlateDecode', params), 'invalid.pdf')).toThrow('row filter')
  expect(() => measureAttachment(variant(encoded(12), '/Filter /FlateDecode', '/DecodeParms << /Predictor 12 /Columns 0 >>'), 'invalid.pdf')).toThrow('Columns')
  expect(() => measureAttachment(variant(Buffer.alloc(20 * 1024 * 1024 + 1), '/Filter /FlateDecode', ''), 'bomb.pdf')).toThrow('oversized')
  expect(measureAttachment(hybridPdfFixture(), 'hybrid.pdf').media_type).toBe('application/pdf')
})

test('all four provider mappers independently refuse FilePiece tool outputs without calling fetch (no hydrator)', async () => {
  const params = { function_tools: [], allow_text_output: true, thinking: null }
  for (const Model of [AnthropicModel, OpenAIResponsesModel, OpenAIChatModel, GoogleModel]) {
    let fetched = 0
    const model = new Model('fixture', { apiKey: 'synthetic', baseUrl: 'http://fixture.invalid', maxRetries: 0, fetchImpl: async () => { fetched++; throw new Error('must not fetch') } })
    const tool = modelRequest([toolReturn('read_file', { status: 'ok', file: { ...attachmentPiece(pdfRef), data: pdf.toString('base64') } }, 'c_file')])
    await expect(model.request([modelRequest([userPrompt('read')]), tool], {}, params)).rejects.toThrow('file tool results are not supported')
    expect(fetched).toBe(0)
  }
})
