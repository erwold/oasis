import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import type { Run, SessionDetail } from '../src/api/types.ts'

/** Opening a session with many finished turns (the store as the app drives it; no server, no HTTP: the API and the
 *  EventSource are stand-ins). Each finished run's transcript is read once — a run listed twice, twice — with at most
 *  a few of one opening's reads on their way at once; nothing of the session is shown until every read is back; the
 *  threads keep the session's order whatever order the answers came in; a failed read is an empty thread; an opening
 *  left (another session opened, the session closed) still reads all it asked and changes nothing; and from the commit
 *  on — stream, session, steers, the reads after, the live runs watched, the evidence — the order is as before. */

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(candidate)) return next(candidate.href, context)
  }
  return next(specifier, context)
} })

/** the log of what the page did, in order */
let log: string[] = []

/** An EventSource the test drives: every one made is kept, with its URL and whether it was closed. */
class FakeSource {
  static made: FakeSource[] = []
  closed = false
  readonly url: string
  constructor(url: string) { this.url = url; FakeSource.made.push(this); log.push(`stream:${url}`) }
  addEventListener() {}
  removeEventListener() {}
  close() { if (!this.closed) log.push(`stream-closed:${this.url}`); this.closed = true }
}
const stored = new Map<string, string>()
Object.assign(globalThis, {
  EventSource: FakeSource,
  window: { addEventListener() {}, removeEventListener() {} },
  document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
})
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) }, clear: () => stored.clear() } })

const { useStore } = await import('../src/state/store.ts')
const { api, ApiError } = await import('../src/api/client.ts')
const initial = useStore.getState()

const run = (id: string, status = 'done'): Run => ({ id, session_id: 's', status, model: 'scripted:a', user_text: id } as unknown as Run)
const detail = (id: string, runs: Run[], extra: Partial<SessionDetail> = {}): SessionDetail => ({
  id, project_id: 'p', model: 'scripted:a', title: id, workspace: null, runs, director: null, interactions: [], relays: [],
  director_notes: [], active_run: null, active_children: [], run_count: runs.length, pending_approvals: [], event_cursor: 7, ...extra,
} as unknown as SessionDetail)
const steerRecord = (id: string, runId: string, sessionId: string) => ({
  id, run_id: runId, session_id: sessionId, text: `words ${id}`, client_request_id: `key ${id}`, status: 'queued', queued_at: '',
  queued_seq: 1, delivered_at: null, delivered_seq: null, request_index: null, reason: null,
})
/** a finished run's transcript: one answer, named by the run and the read that brought it */
const transcript = (runId: string, tag: string | number, steers: unknown[] = []) =>
  ({ run_id: runId, status: 'done', model: 'scripted:a', entries: [{ kind: 'agent', text: `answer ${runId} #${tag}` }], steers })
const answerOf = (runId: string, tag: string | number) => [{ kind: 'agent', runId, text: `answer ${runId} #${tag}` }]
/** Every stand-in below answers in promise reactions only (no timers, no I/O), so once the microtask queue has run
 *  dry every reaction to an answer already given has run. Used only to check that something did NOT happen (no
 *  further read, no commit); progress is always awaited through an explicit barrier (a read started, an opening or
 *  the evidence reached). */
const quiescent = () => new Promise<void>((r) => setImmediate(r))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** transcript reads the test answers when it likes: every call, in the order asked, and how many are on their way */
function heldTranscripts(answer: (runId: string, call: number) => unknown = (runId, call) => transcript(runId, call)) {
  const calls: string[] = []
  const pending: { runId: string; call: number; settle: () => void }[] = []
  const waiting: { count: number; reached: () => void }[] = []
  let inflight = 0, most = 0
  mock.method(api, 'transcript', (runId: string) => {
    const call = calls.length
    calls.push(runId)
    log.push(`t:${runId}`)
    inflight += 1
    most = Math.max(most, inflight)
    const d = deferred<unknown>()
    pending.push({ runId, call, settle: () => { inflight -= 1; d.resolve(answer(runId, call)) } })
    for (const w of waiting.filter((w) => calls.length >= w.count)) { waiting.splice(waiting.indexOf(w), 1); w.reached() }
    return d.promise
  })
  /** resolves once `count` reads in all have been asked */
  const started = (count: number) => calls.length >= count ? Promise.resolve() : new Promise<void>((reached) => { waiting.push({ count, reached }) })
  return {
    calls, pending, started,
    get inflight() { return inflight }, get most() { return most },
    /** answer one read (by its place among those on their way) */
    settle(at = 0) { const [p] = pending.splice(at, 1); p!.settle() },
    /** answer every read on its way, the newest first, and each read asked after, until the openings are done */
    async drain(...openings: Promise<unknown>[]) {
      let done = false
      const all = Promise.allSettled(openings).then(() => { done = true })
      for (;;) {
        while (pending.length) pending.pop()!.settle()
        if (done) return
        await Promise.race([started(calls.length + 1), all])
      }
    },
  }
}

let refreshing: ReturnType<typeof deferred<void>> | null = null
const AFTER = ['loadTree', 'loadCollab', 'refreshGate', 'loadAccess', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'loadDirector'] as const
let unsubscribe = () => {}

beforeEach(() => {
  unsubscribe()
  stored.clear()
  mock.restoreAll()
  useStore.getState().closeSession()
  useStore.setState({ ...initial })
  FakeSource.made = []
  log = []
  refreshing = null
  for (const key of AFTER) useStore.setState({ [key]: async () => { log.push(key) } })
  useStore.setState({
    loadSessionActivity: async () => {}, loadProjects: async () => {}, syncSession: async () => {},
    refreshEvidence: async () => { log.push('evidence'); if (refreshing) await refreshing.promise },
    watchRun: (r: Run, after?: number | null) => { log.push(`watch:${r.id}:${after}`) },
    confirmSteer: (record: unknown) => { log.push(`steer:${(record as { id: string }).id}`) },
  })
  unsubscribe = useStore.subscribe((s, prev) => { if (s.session !== prev.session) log.push(`commit:${s.session?.id ?? 'none'}`) })
})

test('320 finished turns: 320 reads, never more than 8 on their way, the next leaving as one comes back; nothing shown before all are back', async () => {
  const ids = Array.from({ length: 320 }, (_, i) => `r${i}`)
  mock.method(api, 'session', async (id: string) => detail(id, ids.map((i) => run(i))))
  const reads = heldTranscripts()
  const opening = useStore.getState().openSession('s')
  // the first read started: the readers are launched in one synchronous batch, so all 8 have left by the time this
  // continuation runs (read one after another, there would be 1)
  await reads.started(1)
  assert.equal(reads.calls.length, 8, 'eight reads leave at once, before any answer')
  assert.equal(reads.pending.length, 8)
  await quiescent()
  assert.equal(reads.calls.length, 8, 'no ninth read before an answer')
  assert.equal(reads.inflight, 8)
  reads.settle(0)
  await reads.started(9)
  assert.equal(reads.inflight, 8, 'one back: the next leaves')
  let settled = 1
  while (reads.pending.length) {
    assert.equal(useStore.getState().session, null, 'nothing of the session is shown while reads are on their way')
    assert.deepEqual(useStore.getState().threads, {})
    const asked = reads.calls.length
    reads.pending.pop()!.settle()
    settled += 1
    if (asked < 320) await reads.started(asked + 1)
    assert.equal(reads.inflight, Math.min(8, 320 - settled))
  }
  await opening
  assert.equal(reads.calls.length, 320)
  assert.equal(reads.most, 8)
  assert.deepEqual(reads.calls, ids, 'asked in the session\'s order')
  const { threads, session } = useStore.getState()
  assert.equal(session?.id, 's')
  assert.deepEqual(Object.keys(threads), ids)
  for (const [i, id] of ids.entries()) assert.deepEqual(threads[id], answerOf(id, i))
  assert.equal(log.filter((l) => l.startsWith('commit:')).length, 1, 'one commit')
})

test('a few runs are read all at once; none (every run live, or no runs) reads nothing and still opens', async () => {
  let runsNow = [run('a'), run('b'), run('c')]
  mock.method(api, 'session', async (id: string) => detail(id, runsNow))
  const reads = heldTranscripts()
  const opening = useStore.getState().openSession('s')
  await reads.started(3)
  assert.equal(reads.inflight, 3)
  await reads.drain(opening)
  assert.deepEqual(Object.keys(useStore.getState().threads), ['a', 'b', 'c'])

  for (const runs of [[], [run('l1', 'running'), run('l2', 'queued')]]) {
    runsNow = runs
    const asked = reads.calls.length
    await useStore.getState().openSession('z')
    assert.equal(reads.calls.length, asked)
    assert.equal(useStore.getState().session?.id, 'z')
    assert.deepEqual(useStore.getState().threads, {})
  }
})

test('answers in reverse: the threads keep the session\'s order; a run listed twice is read twice, its later read standing at its first place', async () => {
  mock.method(api, 'session', async (id: string) => detail(id, [run('a'), run('b'), run('a'), run('c')]))
  const reads = heldTranscripts()
  const opening = useStore.getState().openSession('s')
  await reads.started(4)
  assert.deepEqual(reads.calls, ['a', 'b', 'a', 'c'])
  await reads.drain(opening) // newest first: c, a (second), b, a (first)
  const { threads } = useStore.getState()
  assert.equal(reads.calls.length, 4)
  assert.deepEqual(Object.keys(threads), ['a', 'b', 'c'])
  assert.deepEqual(threads.a, answerOf('a', 2), 'the later of the two reads of a, as one after another')
  assert.deepEqual(threads.b, answerOf('b', 1))
  assert.deepEqual(threads.c, answerOf('c', 3))
})

test('a refused read, an answer that is no JSON, a connection that fails and a transcript that cannot be read are empty threads; the others are read', async () => {
  const runs = ['ok1', 'http', 'json', 'net', 'shape', 'ok2']
  mock.method(api, 'session', async (id: string) => detail(id, runs.map((i) => run(i))))
  // the real api.transcript over a fetch stand-in (no server)
  const asked: string[] = []
  mock.method(globalThis, 'fetch', async (path: string) => {
    const runId = /\/api\/runs\/([^/]+)\/transcript$/.exec(path)?.[1]
    assert.ok(runId, `only transcripts are fetched: ${path}`)
    asked.push(runId)
    if (runId === 'http') return new Response(JSON.stringify({ detail: 'gone' }), { status: 500 })
    if (runId === 'json') return new Response('not json {', { status: 200 })
    if (runId === 'net') throw new TypeError('Failed to fetch')
    if (runId === 'shape') return new Response(JSON.stringify({ run_id: runId, entries: null }), { status: 200 }) // fromTranscript throws
    return new Response(JSON.stringify(transcript(runId, 'x')), { status: 200 })
  })
  await useStore.getState().openSession('s')
  assert.deepEqual(asked, runs, 'each read once, none again')
  const { threads } = useStore.getState()
  assert.deepEqual(Object.keys(threads), runs)
  for (const id of ['http', 'json', 'net', 'shape']) assert.deepEqual(threads[id], [])
  assert.deepEqual(threads.ok1, answerOf('ok1', 'x'))
  assert.deepEqual(threads.ok2, answerOf('ok2', 'x'))
})

test('live and active runs are not read; only the live are watched (the active run alone is not), after the commit', async () => {
  mock.method(api, 'session', async (id: string) => detail(id, [run('l1', 'running'), run('d1'), run('act'), run('l2', 'queued'), run('f1', 'failed')],
    { active_run: { id: 'act', status: 'done', saved_seq: 0, steerable: false } } as Partial<SessionDetail>))
  const reads = heldTranscripts()
  const opening = useStore.getState().openSession('s')
  await reads.started(2)
  await quiescent()
  assert.deepEqual(reads.calls, ['d1', 'f1'])
  assert.equal(log.filter((l) => l.startsWith('watch:')).length, 0)
  await reads.drain(opening)
  assert.deepEqual(reads.calls, ['d1', 'f1'])
  assert.deepEqual(Object.keys(useStore.getState().threads), ['d1', 'f1'])
  assert.deepEqual(log.filter((l) => l.startsWith('watch:')), ['watch:l1:-1', 'watch:l2:-1'])
})

test('from the last read back on, the order is as before: stream from the detail\'s cursor, one commit, steers in the session\'s order, the reads after, the live watched, the evidence awaited', async () => {
  mock.method(api, 'session', async (id: string) => { log.push(`session:${id}`); return detail(id, [run('d1'), run('l1', 'running'), run('d2'), run('l2', 'queued')]) })
  const reads = heldTranscripts((runId, call) => transcript(runId, call, [steerRecord(`st-${runId}`, runId, 's')]))
  refreshing = deferred<void>()
  const evidenceReached = deferred<void>()
  useStore.setState({ refreshEvidence: async () => { log.push('evidence'); evidenceReached.resolve(); await refreshing!.promise } })
  let opened = false
  const opening = useStore.getState().openSession('s').then(() => { opened = true })
  await reads.started(2)
  assert.deepEqual(log, ['session:s', 't:d1', 't:d2'])
  reads.settle(1) // d2 first
  await quiescent()
  assert.deepEqual(log, ['session:s', 't:d1', 't:d2'], 'no stream, no commit while a read is on its way')
  reads.settle(0)
  await evidenceReached.promise
  assert.deepEqual(log, ['session:s', 't:d1', 't:d2', 'stream:/api/sessions/s/events?after=7', 'commit:s', 'steer:st-d1', 'steer:st-d2',
    ...AFTER, 'watch:l1:-1', 'watch:l2:-1', 'evidence'])
  await quiescent()
  assert.equal(opened, false, 'the opening waits for the evidence')
  refreshing.resolve()
  await opening
  assert.equal(opened, true)
})

test('a detail without a cursor closes the stream open (none is made); a cursor of 0 opens one from 0', async () => {
  mock.method(api, 'session', async (id: string) => detail(id, [run(`${id}-1`)], id === 'none' ? { event_cursor: undefined } : id === 'zero' ? { event_cursor: 0 } : {}))
  mock.method(api, 'transcript', async (runId: string) => transcript(runId, 0))
  await useStore.getState().openSession('first')
  assert.deepEqual(FakeSource.made.map((s) => s.url), ['/api/sessions/first/events?after=7'])
  log = []
  await useStore.getState().openSession('none')
  assert.equal(FakeSource.made.length, 1)
  assert.equal(FakeSource.made[0]!.closed, true)
  assert.deepEqual(log.slice(0, 2), ['stream-closed:/api/sessions/first/events?after=7', 'commit:none'])
  await useStore.getState().openSession('zero')
  assert.deepEqual(FakeSource.made.map((s) => s.url), ['/api/sessions/first/events?after=7', '/api/sessions/zero/events?after=0'])
})

test('A left for B while A\'s reads are on their way: B opens; A still reads every run it asked for, then changes nothing; reopening A reads again', async () => {
  const aIds = Array.from({ length: 20 }, (_, i) => `a${i}`)
  mock.method(api, 'session', async (id: string) => detail(id, id === 'A' ? aIds.map((i) => run(i)) : [run('b0'), run('b1')]))
  const reads = heldTranscripts((runId, call) => transcript(runId, call, [steerRecord(`st-${runId}`, runId, runId.startsWith('a') ? 'A' : 'B')]))
  const openingA = useStore.getState().openSession('A')
  await reads.started(8)
  const openingB = useStore.getState().openSession('B')
  await reads.started(10)
  assert.deepEqual(reads.calls.slice(8), ['b0', 'b1'])
  assert.equal(reads.inflight, 10, 'B\'s reads go beside A\'s: the bound is each opening\'s own')
  reads.settle(9)
  reads.settle(8)
  await openingB
  assert.equal(useStore.getState().session?.id, 'B')
  assert.deepEqual(Object.keys(useStore.getState().threads), ['b0', 'b1'])
  await reads.drain(openingA)
  assert.deepEqual(reads.calls.filter((c) => c.startsWith('a')), aIds, 'A read every run it asked for, once (no cancellation)')
  assert.equal(reads.most, 10)
  assert.equal(useStore.getState().session?.id, 'B')
  assert.deepEqual(Object.keys(useStore.getState().threads), ['b0', 'b1'])
  assert.deepEqual(FakeSource.made.map((s) => s.url), ['/api/sessions/B/events?after=7'], 'A opened no stream')
  assert.deepEqual(log.filter((l) => l.startsWith('commit:')), ['commit:B'])
  assert.deepEqual(log.filter((l) => l.startsWith('steer:')), ['steer:st-b0', 'steer:st-b1'], 'no steer of A taken')
  // nothing kept from the opening left: A's transcripts are read again
  const asked = reads.calls.length
  const again = useStore.getState().openSession('A')
  await reads.started(asked + 8)
  await reads.drain(again)
  assert.deepEqual(reads.calls.slice(asked), aIds)
  assert.equal(useStore.getState().session?.id, 'A')
  for (const [i, id] of aIds.entries()) {
    const rows = useStore.getState().threads[id]!
    assert.deepEqual(rows[0], answerOf(id, asked + i)[0], 'the new opening\'s reads')
    assert.equal(rows[1]?.steer?.id, `st-${id}`)
  }
})

test('closed while its reads are on their way: every read still comes back, nothing opens; two openings of one session read twice, the later one shown', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `r${i}`)
  mock.method(api, 'session', async (id: string) => detail(id, ids.map((i) => run(i))))
  const reads = heldTranscripts()
  const opening = useStore.getState().openSession('A')
  await reads.started(8)
  useStore.getState().closeSession()
  await reads.drain(opening)
  assert.deepEqual(reads.calls, ids)
  assert.equal(useStore.getState().session, null)
  assert.deepEqual(useStore.getState().threads, {})
  assert.equal(FakeSource.made.length, 0)

  // the first opening asks for all its reads (answering 4 of them) before the second begins: every read asked after
  // that is the second opening's
  log = []
  const base = reads.calls.length
  const first = useStore.getState().openSession('A')
  await reads.started(base + 8)
  for (let k = 0; k < 4; k += 1) { reads.settle(0); await reads.started(base + 9 + k) }
  assert.equal(reads.inflight, 8)
  const second = useStore.getState().openSession('A')
  const secondFrom = base + 12
  await reads.started(secondFrom + 8)
  assert.equal(reads.inflight, 16, 'each opening its own 8')
  // the second opening's reads answered (the first's held), then the first's: the stale opening ends last
  while (reads.pending.some((p) => p.call >= secondFrom)) {
    const asked = reads.calls.length
    reads.settle(reads.pending.findIndex((p) => p.call >= secondFrom))
    if (asked < secondFrom + 12) await reads.started(asked + 1)
  }
  await second
  assert.equal(useStore.getState().session?.id, 'A')
  await reads.drain(first)
  assert.equal(reads.calls.length, base + 24)
  assert.deepEqual(reads.calls.slice(base, secondFrom), ids)
  assert.deepEqual(reads.calls.slice(secondFrom), ids)
  assert.deepEqual(log.filter((l) => l.startsWith('commit:')), ['commit:A'])
  assert.equal(FakeSource.made.length, 1)
  for (const [i, id] of ids.entries()) assert.deepEqual(useStore.getState().threads[id], answerOf(id, secondFrom + i), 'the later opening\'s reads')
})

test('a refused session read: the rejection reaches the caller after the opening\'s resets and disposals; no transcript is read, nothing else changes', async () => {
  const refused = new ApiError(404, 'session not found', null)
  mock.method(api, 'session', async () => { throw refused })
  const reads = heldTranscripts()
  let disposed = 0
  const before = detail('old', [])
  useStore.setState({ session: before, busy: 'working', access: {} as never, accessSaving: true, disposers: { r: () => { disposed += 1 } } })
  log = []
  await assert.rejects(useStore.getState().openSession('gone'), (e) => e === refused)
  assert.equal(disposed, 1)
  const s = useStore.getState()
  assert.equal(s.busy, null)
  assert.equal(s.access, null)
  assert.equal(s.accessSaving, false)
  assert.equal(s.session, before)
  assert.equal(reads.calls.length, 0)
  assert.equal(FakeSource.made.length, 0)
  assert.deepEqual(log, [])
})
