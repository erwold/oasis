/** The live link page's store (src/share/live/liveState.ts): each state replaces the last (a late older revision of
 *  the same projection is dropped); pictures fetched once per opaque resource, kept across states whose item keys
 *  moved, checked against their ref (type, length, pixel size), dropped and revoked once no state names them; an end
 *  for good clears everything, aborts every request, and a picture arriving after it is revoked, never shown; a
 *  pause clears what was shown. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LiveConnection, LiveConnectionOptions } from '../src/share/live/connection.ts'
import { createLiveStore, type LiveEnd } from '../src/share/live/liveState.ts'
import { CAPABILITY, imageRef, liveFrame, liveSnapshot, PNG_1X1, RES_A, RES_B } from './liveShareFixtures.ts'
import type { LiveItem, LiveSnapshot, LiveStateFrame } from '@oasis-code/contract'

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 10; i++) await tick() }

function harness(opts: { image?: (path: string, init: RequestInit) => Promise<Response>; measure?: () => Promise<{ width: number; height: number }>; extra?: Partial<Parameters<typeof createLiveStore>[0]> } = {}) {
  let driver!: LiveConnectionOptions<LiveStateFrame, LiveEnd>
  const life = new AbortController()
  let closed = false
  const connect = (<S, E extends string>(o: LiveConnectionOptions<S, E>): LiveConnection => {
    driver = o as unknown as LiveConnectionOptions<LiveStateFrame, LiveEnd>
    return { close: () => { closed = true; life.abort() }, nudge: () => undefined, signal: life.signal }
  }) as NonNullable<Parameters<typeof createLiveStore>[0]['connect']>
  const asked: string[] = []
  const signals: AbortSignal[] = []
  const created: string[] = []
  const revoked: string[] = []
  let n = 0
  const store = createLiveStore({
    capability: CAPABILITY,
    connect,
    fetchImpl: async (path, init) => {
      asked.push(path)
      signals.push(init.signal!)
      return opts.image ? opts.image(path, init) : new Response(PNG_1X1 as BlobPart, { status: 200, headers: { 'content-type': 'image/png' } })
    },
    measure: opts.measure ?? (async () => ({ width: 1, height: 1 })),
    urls: { create: () => { const u = `blob:test/${++n}`; created.push(u); return u }, revoke: (u) => { revoked.push(u) } },
    ...opts.extra,
  })
  store.start()
  return { store, driver: () => driver, asked, signals, created, revoked, closed: () => closed }
}

test('a state replaces the last; an older revision of the same projection arriving late is dropped; a new epoch replaces', async () => {
  const h = harness()
  h.driver().onState(liveFrame({ revision: 5 }))
  h.driver().onState(liveFrame({ revision: 4 }, { title: 'stale' }))
  assert.equal(h.store.get().frame!.revision, 5)
  h.driver().onState(liveFrame({ revision: 6 }, { title: 'newer' }))
  assert.equal(h.store.get().frame!.snapshot.title, 'newer')
  h.driver().onState(liveFrame({ epoch: 'epochBBBB', revision: 1 }, { title: 'restarted' }))
  assert.equal(h.store.get().frame!.snapshot.title, 'restarted')
  assert.equal((h.store.get().frame!.snapshot as LiveSnapshot).items.length, liveSnapshot().items.length, 'replaced, never appended')
})

test('pictures: one request per resource across states whose item keys moved; shown as a blob URL; dropped and revoked once no state names them', async () => {
  const h = harness()
  h.driver().onState(liveFrame({ revision: 1 }))
  assert.equal(h.store.get().pictures.get(RES_A)?.kind, 'loading')
  await settle()
  assert.deepEqual(h.asked, [`/live/api/image/${RES_A}`])
  assert.deepEqual(h.store.get().pictures.get(RES_A), { kind: 'shown', src: 'blob:test/1', width: 1, height: 1 })
  // the same picture under another item key (positional keys moved) and a new one: the first is not asked again
  const items = liveSnapshot().items.map((i, k): LiveItem => ({ ...i, key: `i${k + 10}` }))
  items.push({ kind: 'image', key: 'i99', run: 'r2', at: null, origin: 'screenshot', image: RES_B, omitted: null })
  h.driver().onState(liveFrame({ revision: 2 }, { items, images: [imageRef(RES_A), imageRef(RES_B)] }))
  await settle()
  assert.deepEqual(h.asked, [`/live/api/image/${RES_A}`, `/live/api/image/${RES_B}`])
  // a state without the first: its URL revoked, its entry gone
  h.driver().onState(liveFrame({ revision: 3 }, { items: items.filter((i) => !(i.kind === 'image' && i.image === RES_A)), images: [imageRef(RES_B)] }))
  assert.deepEqual(h.revoked, ['blob:test/1'])
  assert.equal(h.store.get().pictures.has(RES_A), false)
  // a ref of the same resource that says another picture (size): dropped and asked again, never the old one shown
  h.driver().onState(liveFrame({ revision: 4 }, { items, images: [imageRef(RES_A), imageRef(RES_B, { width: 2 })] }))
  assert.ok(h.revoked.includes('blob:test/2'))
  await settle()
  assert.equal(h.store.get().pictures.get(RES_B)?.kind, 'failed', 'the bytes decode to 1×1, not the 2×1 announced')
})

test('a picture that is not the one announced is not shown: another type, another length, another size', async () => {
  for (const [label, image, measure] of [
    ['type', async () => new Response(PNG_1X1 as BlobPart, { status: 200, headers: { 'content-type': 'image/svg+xml' } }), undefined],
    ['length', async () => new Response(PNG_1X1.slice(0, 20) as BlobPart, { status: 200, headers: { 'content-type': 'image/png' } }), undefined],
    ['refused', async () => new Response('no', { status: 404 }), undefined],
    ['size', undefined, async () => ({ width: 9, height: 9 })],
  ] as const) {
    const h = harness({ image: image as never, measure: measure as never })
    h.driver().onState(liveFrame())
    await settle()
    assert.equal(h.store.get().pictures.get(RES_A)?.kind, 'failed', label)
    assert.deepEqual(h.created, [], label)
  }
})

test('an end for good: nothing of the session is left, every request aborted, nothing reconnects; a picture arriving later is revoked and never shown', async () => {
  let release!: (r: Response) => void
  const h = harness({ image: () => new Promise<Response>((r) => { release = r }) })
  h.driver().onState(liveFrame())
  await settle()
  assert.equal(h.signals.length, 1)
  h.driver().onPhase('ended')
  h.driver().onEnded('revoked', true)
  const v = h.store.get()
  assert.equal(v.ended, 'revoked')
  assert.equal(v.frame, null)
  assert.equal(v.pictures.size, 0)
  assert.equal(h.signals[0]!.aborted, true)
  release(new Response(PNG_1X1 as BlobPart, { status: 200, headers: { 'content-type': 'image/png' } }))
  await settle()
  assert.deepEqual(h.created, [])
  assert.equal(h.store.get().pictures.size, 0)
  // a state after the end (a race) is never shown
  h.driver().onState(liveFrame({ revision: 9 }))
  assert.equal(h.store.get().frame, null)
})

test('a pause clears what was shown and says why; the next state shows again; close stops the connection and revokes every URL', async () => {
  const h = harness()
  h.driver().onState(liveFrame())
  await settle()
  h.driver().onEnded('disabled', false)
  assert.equal(h.store.get().paused, 'disabled')
  assert.equal(h.store.get().frame, null)
  assert.deepEqual(h.revoked, ['blob:test/1'])
  h.driver().onState(liveFrame({ epoch: 'epochCCCC' }))
  assert.equal(h.store.get().paused, null)
  await settle()
  h.store.close()
  assert.equal(h.closed(), true)
  assert.deepEqual(h.revoked, ['blob:test/1', 'blob:test/2'])
})

const twoPictures = () => {
  const items: LiveItem[] = [...liveSnapshot().items, { kind: 'image', key: 'i99', run: 'r2', at: null, origin: 'screenshot', image: RES_B, omitted: null }]
  return liveFrame({}, { items, images: [imageRef(RES_A), imageRef(RES_B)] })
}

test('the picture budget is kept strictly with loads under way together: bytes are reserved when a load starts', async () => {
  const gates: (() => void)[] = []
  const h = harness({
    image: () => new Promise<Response>((r) => gates.push(() => r(new Response(PNG_1X1 as BlobPart, { status: 200, headers: { 'content-type': 'image/png' } })))),
    extra: { maxCacheBytes: 100 },
  })
  h.driver().onState(twoPictures())
  await settle()
  // the second never starts: the first's 70 bytes are already held
  assert.equal(h.asked.length, 1)
  assert.equal(h.store.get().pictures.get(RES_B)?.kind, 'failed')
  gates.shift()!()
  await settle()
  assert.equal(h.store.get().pictures.get(RES_A)?.kind, 'shown')
})

test('a picture whose request hangs is given up at its bound and frees its slot for the next', async () => {
  const pending: { fn: () => void; ms: number }[] = []
  const timers = { setTimeout: (fn: () => void, ms: number) => { const p = { fn, ms }; pending.push(p); return p }, clearTimeout: (p: unknown) => { const i = pending.indexOf(p as never); if (i >= 0) pending.splice(i, 1) } }
  let first = true
  const h = harness({
    image: (_path, init) => {
      if (first) { first = false; return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) }
      return Promise.resolve(new Response(PNG_1X1 as BlobPart, { status: 200, headers: { 'content-type': 'image/png' } }))
    },
    extra: { concurrency: 1, imageTimeoutMs: 60_000, timers },
  })
  h.driver().onState(twoPictures())
  await settle()
  assert.equal(h.asked.length, 1)
  assert.equal(pending.length, 1)
  pending.shift()!.fn()
  await settle()
  assert.equal(h.store.get().pictures.get(RES_A)?.kind, 'failed')
  assert.equal(h.asked.length, 2)
  assert.equal(h.store.get().pictures.get(RES_B)?.kind, 'shown')
})
