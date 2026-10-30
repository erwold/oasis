import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunStream, type RunEvent, type EventSourceLike, type ConnectionState } from '../src/api/runStream.ts'

type FakeEvent = { type: string; data?: string; lastEventId: string }

class FakeSource implements EventSourceLike {
  listeners = new Map<string, ((event: FakeEvent) => void)[]>()
  closed = 0
  addEventListener(name: string, listener: (event: FakeEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  close() { this.closed += 1 }
  fire(type: string, data?: string, lastEventId = '') {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, data, lastEventId })
  }
}
function fixture(after: number | null = null, event?: (value: RunEvent) => void) {
  const sources: FakeSource[] = [], cursors: (number | null)[] = [], events: RunEvent[] = []
  const states: ConnectionState[] = [], delays: number[] = []
  const timers = new Map<number, () => void>()
  let nextId = 0, finished = 0
  const stream = createRunStream({
    names: ['text_delta', 'error', 'run_finished', 'message'], after,
    source: (cursor) => { cursors.push(cursor); const s = new FakeSource(); sources.push(s); return s },
    event: (value) => { event?.(value); events.push(value) }, finished: () => { finished += 1 },
    connection: (value) => states.push(value), random: () => 1,
    schedule: (fn, delay) => { delays.push(delay); timers.set(++nextId, fn); return nextId },
    unschedule: (id) => { timers.delete(id as number) },
  })
  const tick = () => { const item = timers.entries().next().value; assert.ok(item); timers.delete(item[0]); item[1]() }
  return { stream, sources, cursors, events, states, timers, delays, tick, finished: () => finished }
}

test('resume cursor and numeric deduplication, including sequence zero', () => {
  const f = fixture(0)
  assert.deepEqual(f.cursors, [0])
  f.sources[0].fire('text_delta', '{"text":"old"}', '0')
  f.sources[0].fire('text_delta', '{"text":"new"}', '1')
  f.sources[0].fire('text_delta', '{"text":"duplicate"}', '1')
  assert.equal(f.events.length, 1)
  f.stream.reconnect()
  assert.deepEqual(f.cursors, [0, 1])
  f.stream.close()
})
test('transport errors retry subscriptions, not application errors or completion', () => {
  const f = fixture()
  f.sources[0].fire('error')
  assert.equal(f.events.length, 0)
  assert.equal(f.finished(), 0)
  assert.equal(f.sources[0].closed, 1)
  assert.deepEqual(f.delays, [1000])
  f.tick()
  assert.equal(f.sources.length, 2)
  f.stream.close()
})
test('named application errors are delivered without closing the transport', () => {
  const f = fixture()
  f.sources[0].fire('error', '{"message":"provider refused"}', '2')
  assert.equal(f.events[0].event, 'error')
  assert.equal(f.timers.size, 0)
  assert.equal(f.finished(), 0)
  f.stream.reconnect()
  assert.equal(f.cursors[1], 2)
  f.stream.close()
})
test('partial stream resumes after accepted data and ignores stale callbacks', () => {
  const f = fixture(), old = f.sources[0]
  old.fire('text_delta', '{"text":"hello"}', '8')
  old.fire('error')
  old.fire('text_delta', '{"text":"stale"}', '9')
  f.tick()
  assert.equal(f.cursors[1], 8)
  f.sources[1].fire('text_delta', '{"text":"duplicate"}', '8')
  f.sources[1].fire('text_delta', '{"text":" world"}', '9')
  assert.deepEqual(f.events.map((e) => e.data.text), ['hello', ' world'])
  f.stream.close()
})
for (const [data, id] of [['{broken', '4'], ['[]', '4'], ['null', '4'], ['{}', 'NaN'], ['{}', '9007199254740992'], ['{}', '-1']]) {
  test(`malformed frame (${data}, ${id}) cannot advance the cursor`, () => {
    const f = fixture(3)
    f.sources[0].fire('text_delta', data, id)
    assert.equal(f.events.length, 0)
    f.tick()
    assert.equal(f.cursors[1], 3)
    f.stream.close()
  })
}
test('consumer failure leaves the replay cursor unchanged', () => {
  const f = fixture(5, () => { throw new Error('reducer failed') })
  f.sources[0].fire('text_delta', '{}', '6')
  f.tick()
  assert.equal(f.cursors[1], 5)
  f.stream.close()
})
test('terminal event closes exactly once and cannot be resurrected', () => {
  const f = fixture()
  f.sources[0].fire('run_finished', '{"status":"completed"}', '10')
  f.sources[0].fire('run_finished', '{}', '10')
  f.sources[0].fire('error')
  f.stream.reconnect(); f.stream.close()
  assert.equal(f.events.length, 1)
  assert.equal(f.finished(), 1)
  assert.equal(f.sources.length, 1)
  assert.equal(f.timers.size, 0)
})
test('unsubscribe cancels pending retries without reporting completion', () => {
  const f = fixture()
  f.sources[0].fire('error')
  f.stream.close(); f.stream.close(); f.stream.reconnect()
  assert.equal(f.timers.size, 0)
  assert.equal(f.finished(), 0)
  assert.equal(f.sources.length, 1)
})
test('backoff is capped and open-only failures cannot reset it', () => {
  const f = fixture()
  for (let i = 0; i < 8; i += 1) {
    f.sources[i].fire('open')
    f.sources[i].fire('error'); f.tick()
  }
  assert.deepEqual(f.delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  f.sources[8].fire('text_delta', '{}', '1')
  f.sources[8].fire('error')
  assert.equal(f.delays.at(-1), 1000)
  f.stream.close()
})
test('manual reconnect cancels a retry and preserves accepted progress', () => {
  const f = fixture()
  f.sources[0].fire('text_delta', '{}', '7')
  f.sources[0].fire('error')
  f.stream.reconnect()
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.cursors, [null, 7])
  f.sources[0].fire('run_finished', '{}', '8')
  assert.equal(f.finished(), 0)
  f.stream.close()
})
test('message is registered once even when named explicitly', () => {
  const f = fixture()
  assert.equal(f.sources[0].listeners.get('message')?.length, 1)
  f.sources[0].fire('message', '{}', '0')
  assert.equal(f.events.length, 1)
  f.stream.close()
})
test('synchronous connection failure retries and can be cancelled', () => {
  let retry: (() => void) | null = null, attempts = 0
  const stream = createRunStream({ names: [], event: () => {}, finished: () => {},
    source: () => { attempts += 1; throw new Error('offline') },
    schedule: (fn) => { retry = fn; return 1 }, unschedule: () => { retry = null },
  })
  assert.equal(attempts, 1)
  assert.ok(retry)
  stream.close()
  assert.equal(retry, null)
})

test('a dropped stream of a run that has ended is closed as finished, not retried; of a live run, retried', async () => {
  for (const over of [true, false]) {
    const sources: FakeSource[] = [], delays: number[] = [], states: ConnectionState[] = []
    let finished = 0, asked = 0
    const stream = createRunStream({
      names: ['text_delta', 'run_finished'], after: 4,
      source: () => { const s = new FakeSource(); sources.push(s); return s },
      event: () => {}, finished: () => { finished += 1 }, connection: (value) => states.push(value), random: () => 1,
      schedule: (_fn, delay) => { delays.push(delay); return delays.length }, unschedule: () => {},
      settled: async () => { asked += 1; return over },
    })
    sources[0]!.fire('error')                        // the server ended the stream: nothing after the cursor
    await Promise.resolve(); await Promise.resolve()
    assert.equal(asked, 1)
    assert.equal(sources[0]!.closed > 0, true)
    if (over) { assert.equal(finished, 1); assert.deepEqual(delays, []); assert.equal(states.at(-1), 'closed') }
    else { assert.equal(finished, 0); assert.deepEqual(delays, [1000]); assert.equal(states.at(-1), 'reconnecting') }
    stream.close()
  }
})

test('a reconnect while the settled question is out owns the stream: the late answer does not close it', async () => {
  const sources: FakeSource[] = []
  let finished = 0
  let answer: (over: boolean) => void = () => {}
  const stream = createRunStream({
    names: ['text_delta'], source: () => { const s = new FakeSource(); sources.push(s); return s },
    event: () => {}, finished: () => { finished += 1 }, schedule: () => 1, unschedule: () => {},
    settled: () => new Promise<boolean>((resolve) => { answer = resolve }),
  })
  sources[0]!.fire('error')
  stream.reconnect()                                 // the tab came back meanwhile
  answer(true)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(finished, 0)
  assert.equal(sources.length, 2)
  assert.equal(sources[1]!.closed, 0)
  stream.close()
})
