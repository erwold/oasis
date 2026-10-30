/** A v2 live link's page state (src/share/live/liveState.ts): a task's sessions, the one shown chosen on the page —
 *  only ITS pictures loaded (another session's dropped and revoked the moment it is not shown), the choice kept while
 *  that session lives and dropped when it is deleted, everything started again with a new epoch, nothing left of any
 *  session when the link ends or the listener is too busy to hold the whole task. Synthetic states only. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LiveConnection, LiveConnectionOptions } from '../src/share/live/connection.ts'
import { busyRefusal, createLiveStore, readLiveEnded, readLiveState, type LiveEnd, type LiveFrame } from '../src/share/live/liveState.ts'
import { CAPABILITY, liveFrame, PNG_1X1, RES_A, RES_B } from './liveShareFixtures.ts'
import { LIVE_S1, LIVE_S2, taskFrame } from './taskShareFixtures.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 10; i++) await tick() }

function harness() {
  let driver!: LiveConnectionOptions<LiveFrame, LiveEnd>
  const life = new AbortController()
  const connect = (<S, E extends string>(o: LiveConnectionOptions<S, E>): LiveConnection => {
    driver = o as unknown as LiveConnectionOptions<LiveFrame, LiveEnd>
    return { close: () => life.abort(), nudge: () => undefined, signal: life.signal }
  }) as NonNullable<Parameters<typeof createLiveStore>[0]['connect']>
  const asked: string[] = []
  const revoked: string[] = []
  let n = 0
  const store = createLiveStore({
    capability: CAPABILITY, connect,
    fetchImpl: async (path) => { asked.push(path); return new Response(PNG_1X1 as BlobPart, { status: 200, headers: { 'content-type': 'image/png' } }) },
    measure: async () => ({ width: 1, height: 1 }),
    urls: { create: () => `blob:test/${++n}`, revoke: (u) => { revoked.push(u) } },
  })
  store.start()
  return { store, driver: () => driver, asked, revoked }
}

const img = (r: string) => `/live/api/image/${r}`

test('either protocol\'s state is read by its own schema; an unknown version is refused; v2\'s `busy` end is read', () => {
  assert.equal(readLiveState(JSON.parse(JSON.stringify(taskFrame()))).snapshot.version, 2)
  assert.equal(readLiveState(JSON.parse(JSON.stringify(liveFrame()))).snapshot.version, 1)
  const three = JSON.parse(JSON.stringify(taskFrame()))
  three.snapshot.version = 3
  assert.throws(() => readLiveState(three))
  // a v2 state whose image item names another session's resource is refused whole
  const crossed = JSON.parse(JSON.stringify(taskFrame()))
  crossed.snapshot.sessions[1].items[3].image = RES_A
  assert.throws(() => readLiveState(crossed))
  assert.equal(readLiveEnded({ reason: 'busy' }), 'busy')
  assert.equal(busyRefusal(429, { error: 'busy' }), true)
  assert.equal(busyRefusal(503, { error: 'unavailable' }), false)
})

test('the session shown: the link\'s own first; only its pictures load; another chosen drops them (revoked) and loads its own', async () => {
  const h = harness()
  h.driver().onState(taskFrame())
  assert.equal(h.store.get().selected, 's2', 'the session the link was made from')
  await settle()
  assert.deepEqual(h.asked, [img(RES_B)])
  assert.equal(h.store.get().pictures.has(RES_A), false)
  h.store.select('s1')
  assert.equal(h.store.get().selected, 's1')
  assert.deepEqual(h.revoked, ['blob:test/1'])
  assert.equal(h.store.get().pictures.has(RES_B), false)
  await settle()
  assert.deepEqual(h.asked, [img(RES_B), img(RES_A)])
  h.store.select('s9')                                                           // no such session: nothing changes
  assert.equal(h.store.get().selected, 's1')
  // a later revision keeps the choice
  h.driver().onState(taskFrame({ revision: 2 }))
  assert.equal(h.store.get().selected, 's1')
  await settle()
  assert.deepEqual(h.asked, [img(RES_B), img(RES_A)], 'not asked again')
})

test('the session shown deleted: the link\'s first again, else the task\'s; its pictures gone; a new epoch starts the choice and the pictures again', async () => {
  const h = harness()
  h.driver().onState(taskFrame())
  h.store.select('s1')
  await settle()
  // s1 deleted from the task: back to s2 (the link's own), s1's picture revoked
  h.driver().onState(taskFrame({ revision: 2 }, [LIVE_S2()], 's2'))
  assert.equal(h.store.get().selected, 's2')
  assert.ok(h.revoked.length >= 1)
  assert.equal(h.store.get().pictures.has(RES_A), false)
  // s2 (the link's own) deleted too, a member left: the task's current
  h.driver().onState(taskFrame({ revision: 3, start: null }, [{ ...LIVE_S1(), key: 's3', images: [], items: LIVE_S1().items.filter((i) => i.kind !== 'image') }], 's3'))
  assert.equal(h.store.get().selected, 's3')
  assert.equal(h.store.get().pictures.size, 0)
  // a new epoch: keys may name other sessions — the choice resets to the link's own, every picture asked again
  const h2 = harness()
  h2.driver().onState(taskFrame())
  h2.store.select('s1')
  await settle()
  h2.driver().onState(taskFrame({ epoch: 'epochBBBB', revision: 1 }))
  assert.equal(h2.store.get().selected, 's2')
  await settle()
  assert.deepEqual(h2.asked, [img(RES_B), img(RES_A), img(RES_B)])
})

test('an end for good or a busy listener: no session, no picture, nothing selected', async () => {
  const h = harness()
  h.driver().onState(taskFrame())
  await settle()
  h.driver().onEnded('busy', false)
  assert.equal(h.store.get().frame, null)
  assert.equal(h.store.get().selected, null)
  assert.equal(h.store.get().paused, 'busy')
  assert.equal(h.store.get().pictures.size, 0)
  assert.deepEqual(h.revoked, ['blob:test/1'])
  // back: the link's own session again
  h.driver().onState(taskFrame({ revision: 2 }))
  assert.equal(h.store.get().selected, 's2')
  assert.equal(h.store.get().paused, null)
  await settle()
  // a refused reconnect that says busy: asked again later (no end), and the view goes meanwhile
  assert.equal(h.driver().refusal(429, { error: 'busy' }), null)
  assert.equal(h.store.get().frame, null)
  assert.equal(h.store.get().paused, 'busy')
  h.driver().onState(taskFrame({ revision: 3 }))
  h.driver().onEnded('revoked', true)
  assert.equal(h.store.get().frame, null)
  assert.equal(h.store.get().ended, 'revoked')
  assert.equal(h.store.get().selected, null)
  h.store.select('s1')
  assert.equal(h.store.get().selected, null)
})

test('a v1 link reconnecting after a busy refusal keeps its last state, as it always did (only a v2 view is dropped whole)', async () => {
  const h = harness()
  h.driver().onState(liveFrame())
  await settle()
  assert.equal(h.driver().refusal(429, { error: 'busy' }), null)
  assert.equal(h.driver().refusal(503, { error: 'busy' }), null)
  assert.equal(h.store.get().frame?.snapshot.version, 1)
  assert.equal(h.store.get().paused, null)
  assert.equal(h.store.get().pictures.get(RES_A)?.kind, 'shown')
  assert.deepEqual(h.revoked, [])
  // nothing shown yet (no frame says which protocol): nothing to drop, nothing paused
  const fresh = harness()
  assert.equal(fresh.driver().refusal(429, { error: 'busy' }), null)
  assert.equal(fresh.store.get().paused, null)
})
