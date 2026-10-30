import assert from 'node:assert/strict'
import test from 'node:test'
import { createRefresher } from '../src/state/refresher.ts'

/** The tree's and the graph's pacing: one read at a time per session, the first at once, the rest folded into one read
 *  after the gap; an ask resolves with a read begun after it; another session aborts the old read. A clock the test
 *  moves stands in for time. */

function clock() {
  let now = 0
  const timers: { at: number; fn: () => void }[] = []
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => { const t = { at: now + ms, fn }; timers.push(t); return t },
    unschedule: (t: unknown) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1) },
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift(); now = next.at; next.fn()
        await new Promise((r) => setTimeout(r, 0))
      }
      now = end
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

test('300 asks over 3 s: at most one read a second, the first at once, none lost', async () => {
  const c = clock()
  const starts: number[] = []
  const r = createRefresher({ load: async () => { starts.push(c.now()) }, now: c.now, schedule: c.schedule, unschedule: c.unschedule })
  const asks: Promise<void>[] = []
  for (let ms = 0; ms < 3000; ms += 10) { asks.push(r.run('s')); await c.advance(10) }
  await c.advance(2000)
  await Promise.all(asks)
  console.log(`refresher: 300 asks over 3000 ms -> ${starts.length} reads at ${starts.join(', ')} ms`)
  assert.equal(starts[0], 0, 'leading: the first ask reads at once')
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i]! - starts[i - 1]! >= 1000, `reads ${starts.join(', ')}`)
  assert.ok(starts.length <= 4, `${starts.length} reads for 300 asks`)
  assert.ok(starts.at(-1)! >= 2990, 'trailing: the last ask is answered by a read begun after it')
})

test('an ask resolves once a read begun after it is done; a read under way does not answer an ask made during it', async () => {
  const c = clock()
  const reads: { started: number; finish: () => void }[] = []
  const r = createRefresher({ load: () => new Promise<void>((resolve) => { reads.push({ started: c.now(), finish: resolve }) }), now: c.now, schedule: c.schedule, unschedule: c.unschedule })
  let first = false, second = false
  void r.run('s').then(() => { first = true })
  await c.advance(100)
  void r.run('s').then(() => { second = true })
  reads[0]!.finish()
  await c.advance(0)
  assert.equal(first, true)
  assert.equal(second, false, 'the read under way began before this ask')
  assert.equal(reads.length, 1, 'singleflight, and the gap holds the next')
  await c.advance(900)
  assert.equal(reads.length, 2)
  assert.equal(reads[1]!.started, 1000)
  reads[1]!.finish()
  await c.advance(0)
  assert.equal(second, true)
})

test('another key: the read under way is aborted, its asks resolve, the new key reads at once', async () => {
  const c = clock()
  const signals: { key: string; signal: AbortSignal }[] = []
  const r = createRefresher({ load: (key, signal) => { signals.push({ key, signal }); return new Promise(() => {}) }, now: c.now, schedule: c.schedule, unschedule: c.unschedule })
  const a = r.run('A')
  const a2 = r.run('A')
  r.run('B')
  await Promise.all([a, a2])
  assert.equal(signals[0]!.signal.aborted, true)
  assert.deepEqual(signals.map((s) => s.key), ['A', 'B'])
  r.reset()
  assert.equal(signals[1]!.signal.aborted, true)
})
