import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionStream, type SessionStreamDeps } from '../src/api/sessionStream.ts'
import type { ConnectionState, RunEvent } from '../src/api/runStream.ts'

/** The session's one stream on the page's side: many runs on one source, each follower handed its run's events once
 *  and in order; a resume that repeats nothing; what a follower lacks read from the run's record in pages, never from
 *  a stream of the run's own (only another session's run is); a lookup or a page that fails tried again; a frame that
 *  is not whole never moves the cursor; nothing left open when it closes. */

class Source {
  readonly listeners = new Map<string, ((event: unknown) => void)[]>()
  closed = false
  readonly after: number
  constructor(after: number) { this.after = after }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  close() { this.closed = true }
  raw(type: string, body: unknown, id: number) { for (const l of this.listeners.get(type) ?? []) l({ type, data: JSON.stringify(body), lastEventId: String(id) }) }
  ready(id: number, live: string[] = []) { this.raw('stream_ready', { cursor: id, live_runs: live }, id) }
  fail() { for (const l of this.listeners.get('error') ?? []) l({}) }
}

/** The server's side: each run's record (what a page reads) and the frames it sends of it. */
function harness(over: Partial<SessionStreamDeps> = {}) {
  const sources: Source[] = []
  const timers: (() => void)[] = []
  const fallbacks: { runId: string; after: number | null; stopped: boolean }[] = []
  const discovered: string[] = []
  const pages: { runId: string; after: number }[] = []
  const record = new Map<string, { seq: number; event: string; data: Record<string, unknown> }[]>()
  const sessions = new Map<string, string>()
  let id = 10
  const stream = createSessionStream({
    sessionId: 's', cursor: 10, names: ['run_started', 'text_delta', 'text_block', 'run_finished'],
    source: (after) => { const s = new Source(after); sources.push(s); return s },
    run: async (runId) => ({ session_id: sessions.get(runId) ?? 's' }),
    history: async (runId, after, limit) => { pages.push({ runId, after }); return { events: (record.get(runId) ?? []).filter((e) => e.seq > after).slice(0, limit) } },
    fallback: (runId, after) => { const f = { runId, after, stopped: false }; fallbacks.push(f); return () => { f.stopped = true } },
    onNewRun: (runId) => discovered.push(runId),
    schedule: (fn) => { timers.push(fn); return fn }, unschedule: (t) => { const i = timers.indexOf(t as () => void); if (i >= 0) timers.splice(i, 1) }, random: () => 0,
    ...over,
  })
  const current = () => sources.at(-1)!
  /** the run says something: written to its record (a delta too: the server holds the run), sent on the stream */
  const say = (runId: string, event: string, data: Record<string, unknown> = {}, send = true) => {
    const events = record.get(runId) ?? []
    record.set(runId, events)
    const seq = events.length
    events.push({ seq, event, data })
    if (event !== 'text_delta') id += 1
    if (send) current().raw(event, { run_id: runId, seq, data }, id)
    return seq
  }
  return { stream, sources, timers, fallbacks, discovered, pages, record, sessions, say, current, id: () => id }
}
const tick = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)) }
function follower() {
  const heard: RunEvent[] = []
  let closed = 0
  const states: ConnectionState[] = []
  return { heard, states, closed: () => closed, seqs: () => heard.map((e) => Number(e.id)), on: (e: RunEvent) => heard.push(e), close: () => { closed += 1 }, conn: (s: ConnectionState) => states.push(s) }
}
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i)

test('24 runs on one source: each follower hears its own run once, in order, and its end', async () => {
  const h = harness()
  assert.equal(h.current().after, 10)
  const runs = Array.from({ length: 24 }, (_, i) => `r${i}`)
  const fs = runs.map(() => follower())
  runs.forEach((id, i) => h.stream.follow(id, -1, fs[i]!.on, fs[i]!.close, fs[i]!.conn))
  for (const r of runs) h.say(r, 'run_started')
  h.current().ready(h.id(), runs)
  await tick()
  for (let k = 1; k <= 3; k += 1) for (const r of runs) h.say(r, 'text_delta', { text: `${r}:${k}` })
  for (const r of runs) h.say(r, 'run_finished')
  assert.equal(h.sources.length, 1)
  runs.forEach((r, i) => {
    assert.deepEqual(fs[i]!.seqs(), upTo(5))
    assert.ok(fs[i]!.heard.slice(1, 4).every((e) => String(e.data.text).startsWith(`${r}:`)), 'no other run\'s words')
    assert.equal(fs[i]!.closed(), 1)
    assert.equal(fs[i]!.states.at(-1), 'closed')
  })
  assert.deepEqual(h.fallbacks, [])
})

test('keep 2: 24 runs past their budget, followed late, are read whole from their record in pages — no stream of their own', async () => {
  const h = harness({ keep: 2, page: 4 })
  const runs = Array.from({ length: 24 }, (_, i) => `r${i}`)
  for (let k = 0; k < 9; k += 1) for (const r of runs) h.say(r, k ? 'text_block' : 'run_started', { k })
  h.current().ready(h.id(), runs)
  const fs = runs.map(() => follower())
  runs.forEach((id, i) => h.stream.follow(id, -1, fs[i]!.on, fs[i]!.close))
  await tick(10)
  for (const r of runs) h.say(r, 'text_block', { k: 9 })                       // the stream goes on meanwhile
  await tick(10)
  assert.equal(h.fallbacks.length, 0, 'no run of this session reads a stream of its own')
  assert.equal(h.sources.length, 1)
  for (const f of fs) assert.deepEqual(f.seqs(), upTo(10), 'whole, each once, in order')
  assert.ok(h.pages.length <= 24 * 3, `${h.pages.length} pages`)
})

test('what the stream says while a follower is caught up waits, and is handed once, after the record', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let record: () => { seq: number; event: string; data: Record<string, unknown> }[] = () => []
  const h = harness({ history: async (_r, after) => { await gate; return { events: record().filter((e) => e.seq > after) } } })
  record = () => h.record.get('a') ?? []
  h.say('a', 'run_started'); h.say('a', 'text_block'); h.current().ready(h.id(), ['a'])
  const first = follower()
  h.stream.follow('a', -1, first.on, first.close)
  await tick()
  // a second view of the run: what the first took is read from the record, slowly; the stream talks meanwhile
  const second = follower()
  h.stream.follow('a', -1, second.on, second.close)
  await tick()
  h.say('a', 'text_block', { late: true })
  assert.deepEqual(second.seqs(), [], 'nothing before the record')
  release()
  await tick()
  h.say('a', 'text_block')
  assert.deepEqual(first.seqs(), [0, 1, 2, 3])
  assert.deepEqual(second.seqs(), [0, 1, 2, 3])
  assert.deepEqual(h.fallbacks, [])
})

test('a drop reconnects after the last whole frame; the replay repeats nothing a follower was handed', async () => {
  const h = harness()
  const f = follower()
  h.stream.follow('a', null, f.on, f.close, f.conn)
  h.say('a', 'run_started')
  h.current().ready(h.id(), ['a'])
  await tick()
  h.say('a', 'text_delta', { text: 'x' })
  h.say('a', 'text_block')
  h.current().fail()
  assert.equal(f.states.at(-1), 'reconnecting')
  h.timers.shift()!()
  const again = h.current()
  assert.equal(again.after, 12, 'one cursor, the last id heard')
  again.raw('text_delta', { run_id: 'a', seq: 1, data: { text: 'x' } }, 11)
  again.raw('text_block', { run_id: 'a', seq: 2, data: {} }, 12)
  h.say('a', 'text_block')
  again.ready(h.id(), ['a'])
  assert.deepEqual(f.seqs(), [0, 1, 2, 3])
  assert.equal(f.states.at(-1), 'connected')
})

test('a frame of valid JSON that is not a whole envelope does not move the cursor: the stream asks for it again', async () => {
  const h = harness()
  const f = follower()
  h.stream.follow('a', -1, f.on, f.close)
  h.say('a', 'run_started')                                                    // id 11
  h.current().ready(11, ['a'])
  await tick()
  h.current().raw('text_block', { run_id: 'a', seq: 1 }, 12)                   // no data
  assert.equal(h.current().closed, true)
  h.timers.shift()!()
  assert.equal(h.current().after, 11, 'resumed before the frame refused, not after it')
  h.current().raw('text_block', { run_id: 'a', seq: 1, data: { text: 'whole' } }, 12)
  h.current().raw('stream_ready', { cursor: 'twelve', live_runs: ['a'] }, 13)  // a stream_ready not whole either
  assert.equal(h.current().closed, true)
  h.timers.shift()!()
  assert.equal(h.current().after, 12)
  assert.deepEqual(f.seqs(), [0, 1])
})

test('a lookup or a page that fails is tried again later: never a stream of the run\'s own', async () => {
  let lookups = 0, reads = 0
  const record = [{ seq: 0, event: 'run_started', data: {} }, { seq: 1, event: 'text_block', data: { text: 'old' } }]
  const h = harness({
    run: async () => { lookups += 1; if (lookups < 3) throw new Error('offline'); return { session_id: 's' } },
    history: async (_r, after) => { reads += 1; if (reads < 2) throw new Error('busy'); return { events: record.filter((e) => e.seq > after) } },
  })
  h.current().ready(10, [])
  const f = follower()
  h.stream.follow('quiet', -1, f.on, f.close)
  await tick()
  for (let i = 0; i < 4 && h.timers.length; i += 1) { h.timers.shift()!(); await tick() }
  assert.equal(h.fallbacks.length, 0)
  assert.ok(lookups >= 3 && reads >= 2, `lookups ${lookups}, reads ${reads}`)
  assert.deepEqual(f.seqs(), [0, 1])
})

test('only a run of another session reads its own stream, and close stops it; close leaves nothing open', async () => {
  const h = harness()
  h.sessions.set('foreign', 'other')
  h.say('mine', 'run_started')
  h.current().ready(h.id(), ['mine'])
  const mine = follower(), foreign = follower()
  h.stream.follow('mine', -1, mine.on, mine.close, mine.conn)
  h.stream.follow('foreign', 3, foreign.on, foreign.close)
  await tick()
  assert.deepEqual(h.fallbacks.map((f) => [f.runId, f.after]), [['foreign', 3]])
  h.stream.close()
  assert.equal(h.fallbacks[0]!.stopped, true, 'the other session\'s stream is closed with this one')
  assert.equal(h.current().closed, true)
  assert.equal(mine.states.at(-1), 'closed')
  h.current().raw('text_block', { run_id: 'mine', seq: 1, data: {} }, 99)
  assert.deepEqual(mine.seqs(), [0])
})

test('the budget across runs: unfollowed runs keep at most keepTotal events together, and a later follow is still whole', async () => {
  const h = harness({ keep: 50, keepTotal: 60 })
  const runs = ['a', 'b', 'c']
  for (let k = 0; k < 40; k += 1) for (const r of runs) h.say(r, 'text_delta', { k })
  h.current().ready(h.id(), runs)
  const fs = runs.map(() => follower())
  runs.forEach((r, i) => h.stream.follow(r, -1, fs[i]!.on, fs[i]!.close))
  await tick(10)
  for (const f of fs) assert.deepEqual(f.seqs(), upTo(40))
  assert.ok(h.pages.length > 0, 'what was let go came from the record')
  assert.equal(h.fallbacks.length, 0)
})
