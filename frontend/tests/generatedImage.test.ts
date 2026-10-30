/** Images the harness generated (the generate_image tool): shown large in the thread with a download, opened in the
 *  viewer with a download, and dragged back into the composer as an attachment — the session's own image joining
 *  without a second upload, another session's read through its own attachment route and uploaded as any file is.
 *  What a drag carries is two ids only: the bytes, their type and their size come from the harness, never from the
 *  drag. A drop resolved after the person moved to another session lands in the composer it was dropped on. */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// the application is bundled by Vite: for Node, its extensionless imports resolve to .ts / .tsx, its components are
// compiled with TypeScript, and an asset import (CSS, an image) is its URL
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) {
        const candidate = new URL(`${specifier}${ext}`, context.parentURL)
        if (existsSync(candidate)) return next(candidate.href, context)
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) {
      const file = fileURLToPath(url)
      const out = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
      return { format: 'module', source: out.outputText, shortCircuit: true }
    }
    return next(url, context)
  },
})

const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) }, clear: () => stored.clear() } })
Object.assign(globalThis, { window: globalThis, __OASIS_CODE_BUILD__: 'test' })
// object URLs and the decoder: the page's, stood in for (a decoder that refuses what is not an image)
let urlSeq = 0
const revoked: string[] = []
Object.assign(URL, { createObjectURL: () => `blob:test/${++urlSeq}`, revokeObjectURL: (u: string) => { revoked.push(u) } })
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
Object.assign(globalThis, {
  createImageBitmap: async (blob: Blob) => {
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
    if (head[0] !== 0x89 || head[1] !== 0x50) throw new Error('The source image could not be decoded.')
    return { width: 64, height: 48, close: () => {} }
  },
})

// every request the page makes, answered by the test (anything else: 404); an answer may be held back
interface Call { method: string; path: string }
let calls: Call[] = []
let answer: (call: Call) => Response | Promise<Response> | undefined = () => undefined
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call = { method: init?.method ?? 'GET', path: String(input) }
  calls.push(call)
  return (await answer(call)) ?? new Response(JSON.stringify({ detail: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const image = (type = 'image/png', bytes: Uint8Array = PNG) => new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { status: 200, headers: { 'content-type': type } })
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)) }

const { useStore } = await import('../src/state/store.ts')
const { switchedComposer } = await import('../src/state/composers.ts')
const { uploadAttachments } = await import('../src/state/attachments.ts')
// imported so a build without the module still runs every test: each then fails on what it asserts, not on a load
const drag: Partial<typeof import('../src/state/imageDrag.ts')> = await import('../src/state/imageDrag.ts').catch(() => ({}))
const { renderToStaticMarkup } = await import('react-dom/server')
const { createElement } = await import('react')
const { Row } = await import('../src/components/Thread.tsx')
const Media = await import('../src/components/Media.tsx')
const ViewerFrame = (Media as Partial<typeof Media>).ViewerFrame ?? (() => null)
const Thread = await import('../src/components/Thread.tsx')
const WorkGroup = (Thread as Record<string, unknown>).WorkGroup as ((props: Record<string, unknown>) => ReturnType<typeof createElement>) | undefined

const initial = { ...useStore.getState() }
const open = (id: string) => useStore.setState({ session: { id } as never })
const images = () => useStore.getState().images
/** a drag this page began on one of its own images (the thread's drag start, as the component calls it); a build
 *  without the registration gets the bare ids it used to put on a drag */
const dragData = (session_id: string, asset_id: string) => drag.beginImageDrag?.(session_id, asset_id) ?? JSON.stringify({ session_id, asset_id })
/** the composer's drop of a dragged image (absent from a build without it: nothing is added) */
const addDragged = async (raw: string) => { await (useStore.getState() as { addDraggedImage?: (raw: string) => Promise<void> }).addDraggedImage?.(raw) }

beforeEach(() => {
  calls = []
  answer = () => undefined
  drag.endImageDrag?.()
  useStore.setState({ ...initial, images: [], composers: {}, toast: null } as never)
})

// ---- what a drag carries ---------------------------------------------------------------------------------------

test('a drag carries a session, an asset and the nonce of the drag this page began, and nothing else is read from it', () => {
  const raw = drag.beginImageDrag?.('s_1', 'a_gen1') ?? ''
  const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed).sort(), ['asset_id', 'nonce', 'session_id'])
  assert.match(String(parsed.nonce), /^[A-Za-z0-9-]{16,64}$/)
  assert.deepEqual(drag.draggedImageOf?.(raw), { session_id: 's_1', asset_id: 'a_gen1', nonce: parsed.nonce })
  assert.equal(drag.IMAGE_DRAG_MIME, 'application/x-oasis-image')
  assert.equal(drag.carriesDraggedImage?.(['text/uri-list', 'application/x-oasis-image', 'Files']), true)
  assert.equal(drag.carriesDraggedImage?.(['Files', 'text/plain']), false)
  for (const forged of [
    '', 'not json', 'null', '[]', '{"session_id":"s_1"}',
    JSON.stringify({ session_id: 's_1', asset_id: 'a_1', nonce: String(parsed.nonce), url: 'https://evil.example/x.png' }),
    JSON.stringify({ session_id: 's_1', asset_id: '../../api/assets/a_1', nonce: String(parsed.nonce) }),
    JSON.stringify({ session_id: 's/1', asset_id: 'a_1', nonce: String(parsed.nonce) }),
    JSON.stringify({ session_id: 's_1', asset_id: 'a'.repeat(129), nonce: String(parsed.nonce) }),
    JSON.stringify({ session_id: 1, asset_id: 'a_1', nonce: String(parsed.nonce) }),
    JSON.stringify({ session_id: 's_1', asset_id: 'a_1', nonce: 'x y' }),
  ]) assert.equal(drag.draggedImageOf?.(forged) ?? null, null, forged)
})

// ---- where a drag comes from: only one this page began on its own image ----------------------------------------

test('a drop no drag of this page began is refused, even with well-formed ids of another session: nothing is read', async () => {
  open('s_2')
  answer = (c) => (c.path === '/api/sessions/s_1/attachments/a_secret' ? image('image/png') : undefined)
  // what a sandboxed frame, another tab or another app can put on a drag: the type and two real-looking ids
  await addDragged(JSON.stringify({ session_id: 's_1', asset_id: 'a_secret' }))
  await addDragged(JSON.stringify({ session_id: 's_1', asset_id: 'a_secret', nonce: '00000000-0000-4000-8000-000000000000' }))
  await tick()
  assert.deepEqual(calls, [])
  assert.deepEqual(images(), [])
})

test("a drag of this page is taken once: the same data dropped again reads nothing", async () => {
  open('s_1')
  answer = (c) => (c.path === '/api/sessions/s_1/attachments/a_gen1' ? image('image/png') : undefined)
  const raw = dragData('s_1', 'a_gen1')
  await addDragged(raw)
  await addDragged(raw)
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(images().length, 1)
  assert.equal(images()[0]!.state, 'ready')
})

test('a drag that ended (dropped elsewhere or cancelled) is no longer taken', async () => {
  open('s_1')
  answer = (c) => (c.path === '/api/sessions/s_1/attachments/a_gen1' ? image('image/png') : undefined)
  const raw = drag.beginImageDrag?.('s_1', 'a_gen1') ?? JSON.stringify({ session_id: 's_1', asset_id: 'a_gen1' })
  drag.endImageDrag?.()
  await addDragged(raw)
  await tick()
  assert.deepEqual(calls, [])
  assert.deepEqual(images(), [])
})

test("a drop naming another image than the drag this page began is refused, and the drag is spent", async () => {
  open('s_1')
  answer = (c) => (c.path.startsWith('/api/sessions/s_1/attachments/') ? image('image/png') : undefined)
  const raw = drag.beginImageDrag?.('s_1', 'a_gen1') ?? JSON.stringify({ session_id: 's_1', asset_id: 'a_gen1' })
  const nonce = (JSON.parse(raw) as { nonce?: string }).nonce ?? ''
  await addDragged(JSON.stringify({ session_id: 's_1', asset_id: 'a_other', nonce }))
  await addDragged(raw)
  await tick()
  assert.deepEqual(calls, [])
  assert.deepEqual(images(), [])
})

test("another session's image dragged on this page still joins, read through its own route", async () => {
  open('s_2')
  answer = (c) => (c.path === '/api/sessions/s_1/attachments/a_gen1' ? image('image/png') : undefined)
  await addDragged(dragData('s_1', 'a_gen1'))
  await tick()
  assert.deepEqual(calls.map((c) => c.path), ['/api/sessions/s_1/attachments/a_gen1'])
  assert.equal(images()[0]!.state, 'ready')
  assert.equal(images()[0]!.uploaded, null)
})

// ---- what is read for a drop: bounded as an upload is ---------------------------------------------------------

/** a response whose body reports when it is cancelled and how much of it was pulled */
function streamed(type: string, size: number, headers: Record<string, string> = {}) {
  const state = { cancelled: false, pulled: 0 }
  const chunk = 256 * 1024
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= size) { controller.close(); return }
      const n = Math.min(chunk, size - state.pulled)
      const bytes = new Uint8Array(n)
      if (state.pulled === 0) bytes.set(PNG.subarray(0, Math.min(8, n)))
      state.pulled += n
      controller.enqueue(bytes)
    },
    cancel() { state.cancelled = true },
  }, { highWaterMark: 0 })
  return { state, response: new Response(body, { status: 200, headers: { 'content-type': type, ...headers } }) }
}

test('a body the harness does not answer as an image is cancelled, not read', async () => {
  open('s_1')
  const html = streamed('text/html', 1024 * 1024)
  answer = () => html.response
  await addDragged(dragData('s_1', 'a_html'))
  await tick()
  assert.equal(images()[0]!.state, 'failed')
  assert.equal(html.state.cancelled, true)
  assert.ok(html.state.pulled < 1024 * 1024)
})

test('an image over the 5 MiB limit is refused: by its declared length before reading, or while reading when it lies', async () => {
  open('s_1')
  const declared = streamed('image/png', 6 * 1024 * 1024, { 'content-length': String(6 * 1024 * 1024) })
  answer = () => declared.response
  await addDragged(dragData('s_1', 'a_big'))
  await tick(20)
  assert.equal(images()[0]!.state, 'failed')
  assert.equal(declared.state.cancelled, true)
  assert.ok(declared.state.pulled < 6 * 1024 * 1024)

  useStore.setState({ images: [] })
  const lying = streamed('image/png', 6 * 1024 * 1024, { 'content-length': '100' })
  answer = () => lying.response
  await addDragged(dragData('s_1', 'a_big2'))
  await tick(40)
  assert.equal(images()[0]!.state, 'failed')
  assert.equal(images()[0]!.uploaded, null)
  assert.ok(lying.state.pulled <= 5 * 1024 * 1024 + 256 * 1024, `read ${lying.state.pulled}`)
})

test('an image over 8000 pixels a side is refused', async () => {
  open('s_1')
  const bitmap = (globalThis as { createImageBitmap: unknown }).createImageBitmap
  Object.assign(globalThis, { createImageBitmap: async () => ({ width: 8001, height: 10, close: () => {} }) })
  try {
    answer = () => image('image/png')
    await addDragged(dragData('s_1', 'a_wide'))
    await tick()
    assert.equal(images()[0]!.state, 'failed')
    assert.equal(images()[0]!.uploaded, null)
  } finally { Object.assign(globalThis, { createImageBitmap: bitmap }) }
})

// ---- dropping it on the composer -------------------------------------------------------------------------------

test("the session's own image joins already uploaded: its bytes read once from the session's route, sent by its id with no upload", async () => {
  open('s_1')
  answer = (c) => (c.path === '/api/sessions/s_1/attachments/a_gen1' ? image('image/webp') : undefined)
  await addDragged(dragData('s_1', 'a_gen1'))
  await tick()
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/sessions/s_1/attachments/a_gen1' }])
  const [one] = images()
  assert.equal(images().length, 1)
  assert.equal(one!.state, 'ready')
  assert.ok(one!.url.startsWith('blob:test/'))
  // the type is the harness's answer, the size the decoder's: nothing the drag said
  assert.equal(one!.file.type, 'image/webp')
  assert.equal(one!.uploaded?.session_id, 's_1')
  assert.deepEqual({ ...one!.uploaded!.attachment, sha256: '' }, { asset_id: 'a_gen1', media_type: 'image/webp', bytes: PNG.length, sha256: '', width: 64, height: 48, name: one!.name })
  assert.match(one!.uploaded!.attachment.sha256 as string, /^[a-f0-9]{64}$/)
  // sending names it by its id: the upload is never called
  let uploads = 0
  const ids = await uploadAttachments('s_1', images, async () => { uploads += 1; throw new Error('no upload expected') }, () => {})
  assert.deepEqual(ids, ['a_gen1'])
  assert.equal(uploads, 0)
})

test("another session's image is read through that session's route and uploaded to this one as any file is", async () => {
  open('s_2')
  answer = (c) => (c.path === '/api/sessions/s_1/attachments/a_gen1' ? image('image/png') : undefined)
  await addDragged(dragData('s_1', 'a_gen1'))
  await tick()
  assert.deepEqual(calls.map((c) => c.path), ['/api/sessions/s_1/attachments/a_gen1'])
  const [one] = images()
  assert.equal(one!.state, 'ready')
  assert.equal(one!.uploaded, null)
  assert.equal(one!.file.type, 'image/png')
  let uploaded: string[] = []
  const ids = await uploadAttachments('s_2', images, async (file, name) => { uploaded.push(name); return { asset_id: 'a_new', media_type: 'image/png', bytes: file.size, sha256: 'x', width: 64, height: 48, name } }, () => {})
  assert.deepEqual(ids, ['a_new'])
  assert.equal(uploaded.length, 1)
})

test('a forged drag reads nothing and adds nothing', async () => {
  open('s_1')
  await addDragged(JSON.stringify({ session_id: 's_1', asset_id: 'a_1', url: 'https://evil.example/x.png' }))
  await addDragged('{"session_id":"s_1","asset_id":"../a"}')
  await tick()
  assert.deepEqual(calls, [])
  assert.deepEqual(images(), [])
})

test('what the harness does not answer as an image never joins as one', async () => {
  open('s_1')
  answer = (c) => (c.path.endsWith('/a_html') ? image('text/html', new TextEncoder().encode('<script>1</script>'))
    : c.path.endsWith('/a_fake') ? image('image/png', new TextEncoder().encode('not a picture')) : undefined)
  for (const id of ['a_html', 'a_fake', 'a_gone']) await addDragged(dragData('s_1', id))
  await tick()
  assert.equal(calls.length, 3)
  assert.equal(images().length, 3)
  for (const one of images()) {
    assert.equal(one.state, 'failed')
    assert.equal(one.uploaded, null)
    assert.ok(one.error)
  }
})

test('a dropped image that could not be read is read again on retry, never sent as an empty file', async () => {
  open('s_1')
  let up = false
  answer = (c) => (up && c.path === '/api/sessions/s_1/attachments/a_gen1' ? image('image/png') : undefined)
  await addDragged(dragData('s_1', 'a_gen1'))
  await tick()
  assert.equal(images().length, 1)
  assert.equal(images()[0]!.state, 'failed')
  up = true
  useStore.getState().retryImage(images()[0]!.id)
  await tick()
  assert.equal(calls.filter((c) => c.path === '/api/sessions/s_1/attachments/a_gen1').length, 2)
  assert.equal(images()[0]!.state, 'ready')
  assert.equal(images()[0]!.file.size, PNG.length)
  assert.equal(images()[0]!.uploaded?.attachment.asset_id, 'a_gen1')
})

test('a drop resolved after the person moved on lands in the composer it was dropped on', async () => {
  open('s_1')
  let release: (r: Response) => void = () => {}
  answer = (c) => (c.path === '/api/sessions/s_1/attachments/a_gen1' ? new Promise<Response>((r) => { release = r }) : undefined)
  const pending = addDragged(dragData('s_1', 'a_gen1'))
  await tick()
  assert.equal(images().length, 1)
  assert.equal(images()[0]!.state, 'converting')     // nothing is sent while it is read
  // to another session: the composer of s_1 is put away, s_2's is shown
  useStore.setState({ ...switchedComposer(useStore.getState(), 's_1', 's_2'), session: { id: 's_2' } as never })
  release(image('image/png'))
  await pending
  await tick()
  assert.deepEqual(images(), [])
  const kept = useStore.getState().composers['s_1']!.images
  assert.equal(kept.length, 1)
  assert.equal(kept[0]!.state, 'ready')
  assert.equal(kept[0]!.uploaded?.session_id, 's_1')
})

test('a full composer refuses a drop before reading anything', async () => {
  open('s_1')
  const full = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, file: new File([PNG], `${i}.png`, { type: 'image/png' }), url: '', name: `${i}.png`, state: 'ready' as const, error: null, uploaded: null }))
  useStore.setState({ images: full })
  await addDragged(dragData('s_1', 'a_gen1'))
  await tick()
  assert.deepEqual(calls, [])
  assert.equal(images().length, 8)
  assert.ok(useStore.getState().toast)
})

// ---- the thread and the viewer --------------------------------------------------------------------------------

const scoped = (child: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(Media.RunScope.Provider, { value: { sessionId: 's_1', workspaceId: null, runId: 'r_1' } }, child))
const generated = (result: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  kind: 'activity', tool: 'generate_image', args: { prompt: 'a red fox in snow' }, status: 'ok', result, ...extra,
})

test("a generated image is shown large, can be dragged, and downloads under the harness's name", () => {
  const html = scoped(createElement(Row, { entry: generated({ generated: true, shown: [{ asset_id: 'a_gen1', width: 1024, height: 1024, label: 'fox.png' }] }) as never }))
  const figure = html.match(/<[^>]*data-testid="generated-image"[^>]*>[\s\S]*?<\/figure>/)?.[0] ?? ''
  assert.ok(figure, html)
  assert.match(figure, /<img[^>]*src="\/api\/sessions\/s_1\/attachments\/a_gen1"[^>]*draggable="true"|<img[^>]*draggable="true"[^>]*src="\/api\/sessions\/s_1\/attachments\/a_gen1"/)
  assert.match(figure, /<a[^>]*data-testid="generated-image-download"[^>]*>/)
  const link = figure.match(/<a[^>]*data-testid="generated-image-download"[^>]*>/)![0]
  assert.match(link, /href="\/api\/sessions\/s_1\/attachments\/a_gen1"/)
  assert.match(link, /download="fox.png"/)
  assert.match(link, /aria-label="Download"/)
  // the line says what was asked; no small thumbnail strip beside the large image
  assert.match(html, /a red fox in snow/)
  assert.doesNotMatch(html, /data-testid="shown-images"/)
})

test('a generate_image call still running shows its line only: no image, no placeholder', () => {
  const html = scoped(createElement(Row, { entry: generated({}, { running: true, status: undefined }) as never }))
  assert.match(html, /a red fox in snow/)
  assert.doesNotMatch(html, /generated-image|<img /)
})

test("an image another tool showed (read_file) keeps its thumbnail, and it can be dragged too", () => {
  const html = scoped(createElement(Row, { entry: { kind: 'activity', tool: 'read_file', args: { path: 'a.png' }, status: 'ok', result: { kind: 'image', shown: [{ asset_id: 'a_r1', width: 10, height: 10, label: 'a.png' }] } } as never }))
  assert.match(html, /data-testid="shown-images"/)
  assert.match(html, /<img[^>]*draggable="true"/)
  assert.doesNotMatch(html, /data-testid="generated-image"/)
})

test("a finished round that is folded still shows the images it generated, once; opened, they are not shown twice", () => {
  const entries = [generated({ generated: true, shown: [{ asset_id: 'a_gen1', width: 64, height: 64, label: 'fox.png' }] }),
    { kind: 'activity', tool: 'read_file', args: { path: 'a.png' }, status: 'ok', result: { kind: 'image', shown: [{ asset_id: 'a_r1', width: 10, height: 10, label: 'a.png' }] } }]
  const render = (opened: boolean) => scoped(WorkGroup ? createElement(WorkGroup, { entries, live: false, opened, receipt: null }) : createElement('div'))
  const folded = render(false)
  assert.equal((folded.match(/data-testid="generated-image"/g) ?? []).length, 1, folded)
  assert.match(folded, /src="\/api\/sessions\/s_1\/attachments\/a_gen1"/)
  assert.doesNotMatch(folded, /a_r1/)                     // another tool's thumbnail stays inside the fold
  const opened = render(true)
  assert.equal((opened.match(/data-testid="generated-image"/g) ?? []).length, 1)
})

test('the viewer offers the picture as a download beside its close', () => {
  const html = renderToStaticMarkup(createElement(ViewerFrame as never, { url: '/api/sessions/s_1/attachments/a_gen1', kind: 'image', label: 'fox.png', download: 'fox.png', onClose: () => {} }))
  const link = html.match(/<a[^>]*data-testid="media-viewer-download"[^>]*>/)?.[0] ?? ''
  assert.match(link, /href="\/api\/sessions\/s_1\/attachments\/a_gen1"/)
  assert.match(link, /download="fox.png"/)
  assert.match(link, /aria-label="Download"/)
  assert.match(html, /aria-label="Close"/)
})

test("a download is named by the harness's label when it names an image, else by the asset", () => {
  assert.equal(drag.downloadNameOf?.({ asset_id: 'a_1', label: 'fox.png' }), 'fox.png')
  assert.equal(drag.downloadNameOf?.({ asset_id: 'a_1', label: 'shots/fox.JPG' }), 'fox.JPG')
  assert.equal(drag.downloadNameOf?.({ asset_id: 'a_1', label: 'notes' }), 'a_1.png')
  assert.equal(drag.downloadNameOf?.({ asset_id: 'a_1', label: null }), 'a_1.png')
})
