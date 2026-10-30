/** The session share's file (v2: the app's own thread, drawn by the viewer bundle the file carries): its CSP, its data
 *  block, the document gate both sides pass, the bundle check; the page's image re-encoding (unchanged); the
 *  generation that ties the snapshot, the pictures, the cosmetic look and the bundle into ONE string = the download's
 *  bytes. The viewer itself, drawing the app's components offline, is tests/shareViewer.test.ts; the snapshot →
 *  product mapping is tests/shareViewModel.test.ts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { type ShareImage, type ShareSnapshotV2 } from '@oasis-code/contract'
import { buildShareHtml, checkViewerBundle, cleanTitle, cspHash, dataBlockJson, sha256, shareCsp, shareFileName, type ViewerBundle } from '../src/state/shareHtml.ts'
import { base64ToBytes, drawSize, PAGE_IMAGE_LIMITS, prepareShareImages, sniffRaster, type ImageCodec, type RasterType } from '../src/state/shareImages.ts'
import { botsWanted, generateShare, optionsKey, ShareBusyError, shareCounts, shareRequest, type ShareAssets, type ShareLook } from '../src/state/share.ts'
import { checkShareDocument, SHARE_PAGE_FORMAT, SHARE_PAGE_VERSION, type ShareDocument } from '../src/share/document.ts'
import { actionSnapshot, HOSTILE, legacyV1Snapshot, snapshotFixture } from './shareFixtures.ts'

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_URL = `data:image/png;base64,${PNG_1x1}`
const BUNDLE: ViewerBundle = { js: 'window.__shareViewer = "ran";', css: '.thread{color:red}' }
const docOf = (over: Partial<ShareDocument> = {}): ShareDocument => ({
  format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION, theme: 'dark', snapshot: snapshotFixture(), pictures: { img1: { src: PNG_URL, width: 1, height: 1 } },
  page: { images_rejected: 0, images_over_page_budget: 0 }, faces: { r1: { bot: '05-bubble', enclosed: false } }, bots: { '05-bubble': PNG_URL }, ...over,
})
const parse = (h: string) => new JSDOM(h).window.document

test('sha256 matches node:crypto (block edges, unicode, 1 MB)', () => {
  const inputs = [new Uint8Array(0), new Uint8Array(55), new Uint8Array(56), new Uint8Array(63), new Uint8Array(64), new Uint8Array(65),
    new TextEncoder().encode('héllo 🌍 </script>'), new Uint8Array(1_000_003).map((_, i) => (i * 31) & 255)]
  for (const b of inputs) assert.equal(Buffer.from(sha256(b)).toString('hex'), createHash('sha256').update(b).digest('hex'))
})


test('the CSP comes first in <head>, hashes exactly the one script and the one style, and allows data: images and fonts only', () => {
  const h = buildShareHtml(docOf(), BUNDLE)
  const doc = parse(h)
  const first = doc.head.children
  assert.equal(first[0]!.getAttribute('charset'), 'utf-8')
  assert.equal(first[1]!.getAttribute('http-equiv'), 'Content-Security-Policy')
  const csp = first[1]!.getAttribute('content')!
  assert.equal(csp, shareCsp(BUNDLE))
  const directives = new Map(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]))
  assert.equal(directives.get('default-src'), "'none'")
  assert.equal(directives.get('script-src'), cspHash(BUNDLE.js))
  assert.equal(directives.get('style-src'), cspHash(BUNDLE.css))
  assert.equal(directives.get('img-src'), 'data:')
  assert.equal(directives.get('font-src'), 'data:')
  for (const d of ['connect-src', 'object-src', 'frame-src', 'child-src', 'worker-src', 'media-src', 'manifest-src', 'form-action', 'base-uri']) assert.equal(directives.get(d), "'none'", d)
  assert.ok(!/unsafe|https?:|\*/.test(csp))
  assert.equal(doc.documentElement.dataset.theme, 'dark')
  // the one stylesheet and the one script are the bundle's exact text; the data block is not a script
  assert.equal(doc.querySelectorAll('style').length, 1)
  assert.equal(doc.querySelector('style')!.textContent, BUNDLE.css)
  const scripts = [...doc.querySelectorAll('script')]
  assert.deepEqual(scripts.map((s) => s.getAttribute('type')), ['application/json', null])
  assert.equal(scripts[1]!.textContent, BUNDLE.js)
  assert.ok(!doc.querySelector('[src],[href],link,iframe,object,embed,base,meta[http-equiv=refresh]'))
})

test('the data block: hostile text of every field stays JSON text — no element, no early end — and reads back as the checked document', () => {
  const evil = snapshotFixture({ title: `T ${HOSTILE} \u2028\u2029 <!-- x`, participants: [{ key: 'p1', role: 'member', label: HOSTILE, model_label: '</script>' }] })
  const d = docOf({ snapshot: evil })
  const h = buildShareHtml(d, BUNDLE)
  const block = h.slice(h.indexOf('id="share-data">') + 16, h.indexOf('</script>', h.indexOf('id="share-data">')))
  assert.ok(!/[<>&\u2028\u2029]/.test(block))
  const doc = parse(h)
  assert.equal(doc.querySelectorAll('script').length, 2)
  assert.equal(doc.querySelectorAll('img,a,iframe').length, 0)
  assert.deepEqual(JSON.parse(doc.getElementById('share-data')!.textContent!), JSON.parse(JSON.stringify(checkShareDocument(d))))
  assert.equal(doc.title, cleanTitle(evil.title))
  assert.equal(dataBlockJson('</script>&'), '"\\u003c/script\\u003e\\u0026"')
})

test('a bundle that would end its own element is refused, as is a missing one', () => {
  assert.throws(() => checkViewerBundle({ js: 'var a="</SCRIPT>"', css: '' }))
  assert.throws(() => checkViewerBundle({ js: 'a<!--b', css: 'x' }))
  assert.throws(() => checkViewerBundle({ js: 'ok', css: 'a{}</style>' }))
  assert.throws(() => checkViewerBundle({ js: '', css: 'x' }))
  assert.doesNotThrow(() => checkViewerBundle({ js: 'var a="<\\/script>"', css: 'x' }))
})

test('the document gate: only the snapshot\'s own keys, raster data URLs, the product\'s bots; no source image bytes, no extra field', () => {
  assert.doesNotThrow(() => checkShareDocument(docOf()))
  const bad: [string, Partial<ShareDocument> | Record<string, unknown>][] = [
    ['svg picture', { pictures: { img1: { src: 'data:image/svg+xml;base64,PHN2Zz4=', width: 1, height: 1 } } }],
    ['web picture', { pictures: { img1: { src: 'https://example.invalid/a.png', width: 1, height: 1 } } }],
    ['picture of no image item', { pictures: { img9: { src: PNG_URL, width: 1, height: 1 } } }],
    ['picture size', { pictures: { img1: { src: PNG_URL, width: 0, height: 1 } } }],
    ['face of no run', { faces: { r99: { bot: '05-bubble', enclosed: false } } }],
    ['face of a path', { faces: { r1: { bot: '../../secret', enclosed: false } } }],
    ['bot not of the product', { bots: { evil: PNG_URL } }],
    ['bot not raster', { bots: { '05-bubble': 'data:text/html,<script>' } }],
    ['theme', { theme: 'neon' as never }],
    ['source bytes', { snapshot: snapshotFixture({ images: [{ key: 'img1', media_type: 'image/png', width: 1, height: 1, bytes: 4, data_base64: 'QUJDRA==' }] }) }],
    ['extra field', { session_id: 'sess_real' }],
  ]
  for (const [why, over] of bad) assert.throws(() => checkShareDocument({ ...docOf(), ...over }), Error, why)
  const extraSnapshot = { ...docOf(), snapshot: { ...snapshotFixture(), config: { secret: 1 } } }
  assert.throws(() => checkShareDocument(extraSnapshot))
})

test('title and file name: invisible and path characters gone, reserved and empty names handled', () => {
  assert.equal(cleanTitle('Fix\u200B the\u202E README\uFEFF'), 'Fix the README')
  assert.equal(cleanTitle('\u200B\u200D'), 'Session')
  assert.equal(shareFileName('Fix\u200B the README / ../etc'), 'Fix-the-README-etc.html')
  assert.equal(shareFileName('..\\..\\secret:*?<>|'), 'secret.html')
  assert.equal(shareFileName(''), 'session.html')
  assert.equal(shareFileName('CON'), 'session-CON.html')
  assert.equal(shareFileName('ＦＵＬＬ'), 'FULL.html')
  assert.equal(shareFileName('a'.repeat(300)).length, 80 + 5)
  assert.equal(shareFileName('修复 登录 bug'), '修复-登录-bug.html')
  assert.ok(!/[\p{Cf}\p{Cc}\/\\]/u.test(shareFileName('a\u2066b\u0000c/\u{E0041}d')))
})


// ---- images ------------------------------------------------------------------------------------------------------

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const WEBP = (n = 20) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...new Array(n).fill(1)])
const png = (n = 20) => new Uint8Array([...PNG_SIG, ...new Array(n).fill(7)])
const source = (key: string, bytes: Uint8Array, over: Partial<ShareImage> = {}): ShareImage => ({ key, media_type: 'image/png', width: 10, height: 20, bytes: bytes.length, data_base64: b64(bytes), ...over })

function fakeCodec(opts: { size?: (b: Uint8Array) => [number, number]; out?: (w: number, h: number) => Uint8Array; failDecode?: boolean } = {}) {
  let live = 0, maxLive = 0, decodes = 0, releases = 0
  const codec: ImageCodec<{ id: number }> = {
    async decode(bytes: Uint8Array, _type: RasterType) {
      if (opts.failDecode) throw new Error('not an image')
      decodes++; live++; maxLive = Math.max(maxLive, live)
      const [w, h] = opts.size ? opts.size(bytes) : (bytes[0] === 0x52 ? [10, 20] : [10, 20])
      return { image: { id: decodes }, width: w, height: h }
    },
    async encode(_i, w, h) { return opts.out ? opts.out(w, h) : WEBP() },
    release() { releases++; live-- },
  }
  return { codec, stats: () => ({ maxLive, decodes, releases }) }
}

test('images are re-encoded one at a time, each output checked again; the source string is not kept', async () => {
  const f = fakeCodec()
  const src = png()
  const r = await prepareShareImages([source('img1', src), source('img2', png(30))], f.codec)
  assert.equal(r.images.size, 2)
  assert.ok(r.images.get('img1')!.dataUrl.startsWith('data:image/webp;base64,'))
  assert.ok(!r.images.get('img1')!.dataUrl.includes(b64(src)))
  assert.equal(f.stats().maxLive, 1)
  assert.equal(f.stats().decodes, f.stats().releases)
  assert.equal(r.bytes, WEBP().length * 2)
})

test('images: a wrong signature, length, size, a non-raster output or a failing re-check is rejected and counted', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
  const cases: [ShareImage[], ReturnType<typeof fakeCodec>][] = [
    [[source('a', svg)], fakeCodec()],
    [[source('a', png(), { bytes: 99 })], fakeCodec()],
    [[source('a', png(), { media_type: 'image/jpeg' })], fakeCodec()],
    [[{ ...source('a', png()), data_base64: '%%%' }], fakeCodec()],
    [[source('a', png())], fakeCodec({ size: () => [11, 20] })],
    [[source('a', png())], fakeCodec({ out: () => new TextEncoder().encode('<html>') })],
    [[source('a', png())], fakeCodec({ failDecode: true })],
    [[source('a', png())], fakeCodec({ size: (b) => (b[0] === 0x52 ? [5, 5] : [10, 20]) })],
  ]
  for (const [srcs, f] of cases) {
    const r = await prepareShareImages(srcs, f.codec)
    assert.equal(r.images.size, 0)
    assert.equal(r.omissions.images_rejected, 1)
    assert.equal(f.stats().decodes, f.stats().releases)
  }
  // a turned JPEG (orientation applied) is accepted
  assert.equal((await prepareShareImages([source('a', png())], fakeCodec({ size: (b) => (b[0] === 0x89 ? [20, 10] : [20, 10]) }).codec)).images.size, 1)
  // past the page's per-image budget
  const big = await prepareShareImages([source('a', png())], fakeCodec({ out: () => WEBP(PAGE_IMAGE_LIMITS.max_image_bytes) }).codec)
  assert.equal(big.omissions.images_over_page_budget, 1)
  assert.deepEqual(drawSize(8000, 4000, 2400), { width: 2400, height: 1200 })
  assert.equal(sniffRaster(new Uint8Array([0xff, 0xd8, 0xff, 0])), 'image/jpeg')
  assert.equal(base64ToBytes('abc'), null)
})

// ---- generation ----------------------------------------------------------------------------------------------------

const SECRET_RUN_ID = 'run_realIdNeverInTheFile123'
const LOOK: ShareLook = { theme: 'claude', faceOf: (id) => (id === SECRET_RUN_ID ? { bot: '05-bubble', enclosed: true } : null) }
const ASSETS: ShareAssets = { viewer: async () => BUNDLE, bot: async () => PNG_URL }

function response(over: Partial<ShareSnapshotV2> = {}) {
  return { snapshot: snapshotFixture(over), selection: { runs: [{ run_id: SECRET_RUN_ID, key: 'r1', label: 'Main run', status: 'done' as const }] } }
}

test('generation: the preview string and the download bytes are one; no selection id, no source image bytes', async () => {
  const srcPng = png()
  const body = response({ images: [source('img1', srcPng)] })
  let asked: unknown = null
  const bots: string[] = []
  const assets: ShareAssets = { viewer: async () => BUNDLE, bot: async (name) => { bots.push(name); return PNG_URL } }
  const built = await generateShare(async (b) => { asked = b; return body }, { tools: true, images: true, excluded: [SECRET_RUN_ID] }, fakeCodec().codec, new AbortController().signal, LOOK, assets)
  assert.deepEqual(asked, { include_tool_details: true, include_images: true, exclude_run_ids: [SECRET_RUN_ID] })
  assert.deepEqual(built.bytes, new TextEncoder().encode(built.html))
  assert.equal(built.sha256, createHash('sha256').update(built.bytes).digest('hex'))
  assert.ok(!built.html.includes(SECRET_RUN_ID))
  assert.ok(!built.html.includes(b64(srcPng)))
  assert.equal(built.fileName, 'Fix-the-README-etc.html')
  assert.equal(built.images, 1)
  assert.equal(built.runs[0]!.run_id, SECRET_RUN_ID)
  assert.equal(built.key, optionsKey({ tools: true, images: true, excluded: [SECRET_RUN_ID] }))
  assert.equal(shareCounts(built).redacted, 4)
  assert.equal(shareCounts(built).omitted, 3)
  // the look: the face the app drew for the one run it named, by its share key; the others without a face, said so
  const doc = JSON.parse(parse(built.html).getElementById('share-data')!.textContent!) as ShareDocument
  assert.deepEqual(doc.faces, { r1: { bot: '05-bubble', enclosed: true } })
  assert.equal(built.facesMissing, 4)
  assert.equal(doc.theme, 'claude')
  assert.deepEqual(bots, ['05-bubble', 'director'])
  assert.deepEqual(Object.keys(doc.bots).sort(), ['05-bubble', 'director'])
  assert.deepEqual(Object.keys(doc.pictures), ['img1'])
  assert.equal(doc.snapshot.images.length, 0)
  assert.equal(built.parts.viewerJs, BUNDLE.js.length)
  assert.ok(built.parts.data > 0 && built.parts.pictures > 0 && built.parts.bots > 0)
})

test('generation: a face of no product bot, or a bot picture that is not a raster data URL, never reaches the file', async () => {
  const look: ShareLook = { theme: 'light', faceOf: () => ({ bot: '../../../etc/passwd', enclosed: false }) }
  const assets: ShareAssets = { viewer: async () => BUNDLE, bot: async () => 'data:image/svg+xml;base64,PHN2Zz4=' }
  const built = await generateShare(async () => response(), { tools: true, images: true, excluded: [] }, fakeCodec().codec, new AbortController().signal, look, assets)
  const doc = JSON.parse(parse(built.html).getElementById('share-data')!.textContent!) as ShareDocument
  assert.deepEqual(doc.faces, {})
  assert.equal(built.facesMissing, 5)
  assert.deepEqual(doc.bots, {})
  assert.deepEqual(botsWanted(snapshotFixture({ items: [] }), {}), [])
})

test('generation: 409 session_active is a ShareBusyError; a mismatched or malformed answer and an abort fail', async () => {
  const signal = new AbortController().signal
  await assert.rejects(generateShare(async () => { throw Object.assign(new Error('409'), { status: 409, detail: 'busy', body: { code: 'session_active', reasons: ['a run is running'] } }) }, { tools: false, images: false, excluded: [] }, fakeCodec().codec, signal, LOOK, ASSETS),
    (e: unknown) => e instanceof ShareBusyError && e.reasons[0] === 'a run is running')
  await assert.rejects(generateShare(async () => response(), { tools: false, images: false, excluded: [] }, fakeCodec().codec, signal, LOOK, ASSETS), /does not match/)
  await assert.rejects(generateShare(async () => ({ ...response(), extra: 1 }), { tools: true, images: true, excluded: [] }, fakeCodec().codec, signal, LOOK, ASSETS))
  const bad = response(); (bad.snapshot as Record<string, unknown>).config = { secret: 1 }
  await assert.rejects(generateShare(async () => bad, { tools: true, images: true, excluded: [] }, fakeCodec().codec, signal, LOOK, ASSETS))
  const ctl = new AbortController()
  await assert.rejects(generateShare(async () => { ctl.abort(new Error('superseded')); return response() }, { tools: true, images: true, excluded: [] }, fakeCodec().codec, ctl.signal, LOOK, ASSETS), /superseded/)
  assert.throws(() => shareRequest({ tools: false, images: false, excluded: ['not-a-run'] }))
})

test('the bots a file carries: ChatGPT\'s mark for an action ChatGPT took, even with no agent words of it — in V2 and in an older V1', () => {
  const v2 = actionSnapshot()
  const onlyAction = { ...v2, items: v2.items.filter((i) => i.key === 'i3') }
  assert.deepEqual(botsWanted(onlyAction, {}), ['chatgpt'])
  const byHand = { ...v2, items: v2.items.filter((i) => i.key === 'i4'), runs: v2.runs.filter((r) => r.key === 'r3') }
  assert.deepEqual(botsWanted(byHand, {}), [])
  // an older snapshot says who only in its action run's label
  const v1 = legacyV1Snapshot()
  assert.deepEqual(botsWanted({ ...v1, items: v1.items.filter((i) => i.key === 'i3') }, {}), ['chatgpt'])
})

test('generation of a V2 snapshot with actions: the file holds the V2 snapshot the gate reads; an action\'s run wears no face and none is missing', async () => {
  const snapshot = actionSnapshot()
  const body = { snapshot, selection: { runs: [{ run_id: SECRET_RUN_ID, key: 'r1', label: 'Main run', status: 'done' as const }, { run_id: 'run_wokenSecret0001', key: 'r6', label: 'Woken', status: 'done' as const }] } }
  const bots: string[] = []
  const built = await generateShare(async () => body, { tools: false, images: false, excluded: [] }, fakeCodec().codec, new AbortController().signal,
    { theme: 'light', faceOf: () => ({ bot: '05-bubble', enclosed: false }) }, { viewer: async () => BUNDLE, bot: async (name) => { bots.push(name); return PNG_URL } })
  const doc = checkShareDocument(JSON.parse(parse(built.html).getElementById('share-data')!.textContent!))
  assert.equal(doc.snapshot.version, 2)
  assert.deepEqual(doc.snapshot.items.filter((i) => i.kind === 'action').map((i) => i.key), ['i3', 'i4', 'i5', 'i11', 'i12'])
  assert.deepEqual(Object.keys(doc.faces).sort(), ['r1', 'r6'])
  assert.equal(built.facesMissing, 0)
  assert.ok(bots.includes('chatgpt'))
  assert.ok(!built.html.includes(SECRET_RUN_ID))
  // the builder writes the latest version only: a V1 answer is refused
  await assert.rejects(generateShare(async () => ({ ...body, snapshot: legacyV1Snapshot() }), { tools: false, images: false, excluded: [] }, fakeCodec().codec, new AbortController().signal, LOOK, ASSETS))
})
