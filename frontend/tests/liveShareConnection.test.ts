/** The live link page's one way out (src/share/live/connection.ts) against a scripted server: exact same-origin paths,
 *  the capability in its header only, no redirect, no cache; whole states replacing each other; heartbeats; an end
 *  for good stops everything; a pause, a dropped stream, a busy server reconnect after a bounded, growing wait; an
 *  unknown capability, a gone link, a state of another format end with their own reasons. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liveRequest, openLiveConnection, reconnectDelay, type FetchLike, type LivePhase, type Timers } from '../src/share/live/connection.ts'
import { liveRefusal, readLiveEnded, readLiveState, type LiveEnd, type LiveFrame } from '../src/share/live/liveState.ts'
import { CAPABILITY, endedEvent, liveFrame, stateEvent } from './liveShareFixtures.ts'
import { LIVE_PERMANENT_END } from '@oasis-code/contract'

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 20; i++) await tick() }

/** A stream the test writes into, chunk by chunk. */
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const enc = new TextEncoder()
  return {
    body,
    write: (s: string) => controller.enqueue(enc.encode(s)),
    close: () => { try { controller.close() } catch { /* closed */ } },
  }
}

interface Call { path: string; init: RequestInit }
function server() {
  const calls: Call[] = []
  const answers: (() => Response)[] = []
  const fetchImpl: FetchLike = async (path, init) => {
    calls.push({ path, init })
    const next = answers.shift()
    if (!next) throw new TypeError('network down')
    const res = next()
    init.signal?.addEventListener('abort', () => { void res.body?.cancel().catch(() => undefined) })
    return res
  }
  return { calls, answers, fetchImpl }
}
const sse = (s: ReturnType<typeof stream>) => () => new Response(s.body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = []
  let n = 0
  const timers: Timers = {
    setTimeout: (fn, ms) => { const id = ++n; pending.push({ fn, ms, id }); return id },
    clearTimeout: (h) => { const i = pending.findIndex((p) => p.id === h); if (i >= 0) pending.splice(i, 1) },
  }
  /** run the timers waiting `ms` (reconnects) — the silence timer (the longest) is left unless asked */
  const fire = (pred: (ms: number) => boolean) => { const due = pending.filter((p) => pred(p.ms)); for (const p of due) { timers.clearTimeout(p.id); p.fn() } return due.map((p) => p.ms) }
  return { timers, pending, fire }
}

function open(s: ReturnType<typeof server>, t: ReturnType<typeof fakeTimers>) {
  const states: LiveFrame[] = []
  const ends: [LiveEnd, boolean][] = []
  const phases: LivePhase[] = []
  const c = openLiveConnection<LiveFrame, LiveEnd>({
    capability: CAPABILITY, readState: readLiveState, readEnded: readLiveEnded, refusal: liveRefusal, unreadable: 'unreadable',
    permanent: (r) => (LIVE_PERMANENT_END as readonly string[]).includes(r) || r === 'unauthorized' || r === 'unreadable' || r === 'refused',
    onState: (f) => states.push(f), onEnded: (r, p) => ends.push([r, p]), onPhase: (p) => phases.push(p),
    fetchImpl: s.fetchImpl, timers: t.timers, random: () => 1, silenceMs: 45_000, baseDelayMs: 1_000, maxDelayMs: 30_000,
  })
  return { c, states, ends, phases }
}

test('the request: the stream path of the page\'s origin, the capability as a Bearer header only, no redirect, no cache, no referrer', async () => {
  const s = server(); const t = fakeTimers(); const st = stream()
  s.answers.push(sse(st))
  const { c } = open(s, t)
  await settle()
  const [call] = s.calls
  assert.equal(call!.path, '/live/api/stream')
  assert.ok(!call!.path.includes(CAPABILITY))
  const h = call!.init.headers as Record<string, string>
  assert.equal(h.Authorization, `Bearer ${CAPABILITY}`)
  assert.equal(h.Accept, 'text/event-stream')
  assert.equal(call!.init.redirect, 'error')
  assert.equal(call!.init.cache, 'no-store')
  assert.equal(call!.init.referrerPolicy, 'no-referrer')
  assert.equal(call!.init.method, 'GET')
  c.close()
  // any other path is refused before anything is asked
  const asked: string[] = []
  const f: FetchLike = async (p) => { asked.push(p); return new Response('') }
  for (const p of ['/api/sessions', '/live/api/image/img1', '/live/api/image/../stream', 'https://evil.invalid/live/api/stream', '/live/api/stream?x=1']) {
    await assert.rejects(liveRequest(p, CAPABILITY, { signal: new AbortController().signal, accept: '*/*' }, f))
  }
  assert.deepEqual(asked, [])
})

test('whole states replace each other; heartbeats keep it alive; an end for good stops everything, nothing reconnects', async () => {
  const s = server(); const t = fakeTimers(); const st = stream()
  s.answers.push(sse(st))
  const { c, states, ends, phases } = open(s, t)
  await settle()
  st.write(': keep-alive\n\n')
  st.write(stateEvent(liveFrame({ revision: 1 })).slice(0, 40))
  await settle()
  assert.equal(states.length, 0)
  st.write(stateEvent(liveFrame({ revision: 1 })).slice(40))
  st.write(stateEvent(liveFrame({ revision: 2 })))
  await settle()
  assert.deepEqual(states.map((f) => f.revision), [1, 2])
  assert.ok(phases.includes('connected'))
  st.write('event: patch\ndata: {"ignored":true}\n\n')
  st.write(endedEvent('revoked'))
  await settle()
  assert.deepEqual(ends, [['revoked', true]])
  assert.equal(phases.at(-1), 'ended')
  assert.equal(c.signal.aborted, true)
  // nothing waits to reconnect, and nothing more is asked
  assert.deepEqual(t.fire(() => true), [])
  await settle()
  assert.equal(s.calls.length, 1)
})

test('a pause (the listener off) is said as not for good, then reconnects; the next connection starts with a whole state', async () => {
  const s = server(); const t = fakeTimers(); const a = stream(); const b = stream()
  s.answers.push(sse(a), sse(b))
  const { c, states, ends, phases } = open(s, t)
  await settle()
  a.write(stateEvent(liveFrame({ revision: 3 })))
  a.write(endedEvent('disabled'))
  await settle()
  assert.deepEqual(ends, [['disabled', false]])
  assert.equal(phases.at(-1), 'reconnecting')
  const waits = t.fire((ms) => ms < 45_000)
  assert.equal(waits.length, 1)
  await settle()
  assert.equal(s.calls.length, 2)
  // the paused stream's id is not sent again: the server starts over with a whole state
  assert.equal((s.calls[1]!.init.headers as Record<string, string>)['Last-Event-ID'], undefined)
  b.write(stateEvent(liveFrame({ epoch: 'epochBBBB', revision: 1 })))
  await settle()
  assert.deepEqual(states.map((f) => `${f.epoch}.${f.revision}`), ['epochAAAA.3', 'epochBBBB.1'])
  c.close()
})

test('a dropped stream and a busy server reconnect after a growing wait, capped; a state resets the wait; Last-Event-ID is sent back', async () => {
  const s = server(); const t = fakeTimers(); const a = stream()
  s.answers.push(sse(a), json(503, { error: 'busy' }), json(429, { error: 'busy' }))
  const { c } = open(s, t)
  await settle()
  a.write(stateEvent(liveFrame({ revision: 7 })))
  await settle()
  a.close()
  await settle()
  const w1 = t.fire((ms) => ms < 45_000)
  await settle()
  const w2 = t.fire((ms) => ms < 45_000)
  await settle()
  // the next ask finds the network down (no answer scripted)
  const w3 = t.fire((ms) => ms < 45_000)
  await settle()
  assert.deepEqual([w1, w2, w3], [[1000], [2000], [4000]])
  assert.equal((s.calls[1]!.init.headers as Record<string, string>)['Last-Event-ID'], 'epochAAAA.7')
  assert.equal(reconnectDelay(40, 1000, 30_000, () => 1), 30_000)
  assert.ok(reconnectDelay(3, 1000, 30_000, () => 0) >= 2000)
  c.close()
  assert.deepEqual(t.fire(() => true), [])
})

test('silence past the heartbeat bound drops the stream and asks again', async () => {
  const s = server(); const t = fakeTimers(); const a = stream(); const b = stream()
  s.answers.push(sse(a), sse(b))
  const { c } = open(s, t)
  await settle()
  a.write(stateEvent(liveFrame()))
  await settle()
  assert.deepEqual(t.fire((ms) => ms === 45_000), [45_000])
  await settle()
  t.fire((ms) => ms < 45_000)
  await settle()
  assert.equal(s.calls.length, 2)
  c.close()
})

test('refusals: an unknown capability and a gone link end with their own reasons; a state of another format ends as unreadable', async () => {
  for (const [answer, want] of [
    [json(401, { error: 'unauthorized' }), 'unauthorized'],
    [json(410, { error: 'gone', reason: 'expired' }), 'expired'],
    [json(410, { error: 'gone', reason: 'revoked' }), 'revoked'],
    [json(404, { error: 'not_found' }), 'refused'],
  ] as const) {
    const s = server(); const t = fakeTimers()
    s.answers.push(answer)
    const { ends } = open(s, t)
    await settle()
    assert.deepEqual(ends, [[want, true]], want)
    assert.deepEqual(t.fire(() => true), [])
  }
  const s = server(); const t = fakeTimers(); const a = stream()
  s.answers.push(sse(a))
  const { ends, states } = open(s, t)
  await settle()
  const other = JSON.parse(JSON.stringify(liveFrame())) as { snapshot: { version: number } }
  other.snapshot.version = 2
  a.write(`event: state\ndata: ${JSON.stringify(other)}\n\n`)
  await settle()
  assert.deepEqual(states, [])
  assert.deepEqual(ends, [['unreadable', true]])
  // not an event stream at all
  const s2 = server(); const t2 = fakeTimers()
  s2.answers.push(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  const second = open(s2, t2)
  await settle()
  assert.deepEqual(second.ends, [['unreadable', true]])
})

test('a state with a field the schema does not know is refused whole (strict), never shown in part', () => {
  const raw = JSON.parse(JSON.stringify(liveFrame())) as Record<string, unknown> & { snapshot: Record<string, unknown> }
  raw.snapshot.extra = 'x'
  assert.throws(() => readLiveState(raw))
  assert.throws(() => readLiveEnded({ reason: 'whatever' }))
  assert.equal(readLiveEnded({ reason: 'server_closing' }), 'server_closing')
  assert.equal(liveRefusal(503, { error: 'unavailable' }), null)
  assert.equal(liveRefusal(500, null), null)
})

test('a half-open connection (no answer, or a refusal whose body never ends) is dropped at the silence bound and asked again', async () => {
  const s = server(); const t = fakeTimers(); const b = stream()
  // first: an answer that never comes (only an abort ends it); second: a 503 whose body never ends; third: a stream
  const hung: FetchLike = async (path, init) => {
    s.calls.push({ path, init })
    const n = s.calls.length
    if (n === 1) return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    if (n === 2) return new Response(new ReadableStream<Uint8Array>({ start() { /* never ends */ } }), { status: 503, headers: { 'content-type': 'application/json' } })
    return new Response(b.body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const states: LiveFrame[] = []
  const c = openLiveConnection<LiveFrame, LiveEnd>({
    capability: CAPABILITY, readState: readLiveState, readEnded: readLiveEnded, refusal: liveRefusal, unreadable: 'unreadable', permanent: () => true,
    onState: (f) => states.push(f), onEnded: () => undefined, onPhase: () => undefined, fetchImpl: hung, timers: t.timers, random: () => 1, silenceMs: 45_000,
  })
  await settle()
  assert.equal(s.calls.length, 1)
  assert.deepEqual(t.fire((ms) => ms === 45_000), [45_000], 'the silence bound is armed while the answer is awaited')
  await settle()
  assert.equal(s.calls[0]!.init.signal!.aborted, true)
  t.fire((ms) => ms < 45_000)
  await settle()
  assert.equal(s.calls.length, 2)
  assert.deepEqual(t.fire((ms) => ms === 45_000), [45_000], 'and while a refusal\'s body is read')
  await settle()
  t.fire((ms) => ms < 45_000)
  await settle()
  assert.equal(s.calls.length, 3)
  b.write(stateEvent(liveFrame()))
  await settle()
  assert.equal(states.length, 1)
  c.close()
})
