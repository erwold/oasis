import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { UiState } from '@oasis-code/contract'
import { createQueueRegistry, type QueueDeps, type QueueView, type SurfaceTarget } from '../src/state/uiQueue.ts'
import type { ActionSnapshot } from '../src/state/uiSurface.ts'

/** A clock the test turns by hand. */
function manualTimers() {
  let next = 1
  const pending = new Map<number, () => void>()
  return {
    timers: { set: (fn: () => void) => { const id = next++; pending.set(id, fn); return id }, clear: (h: unknown) => { pending.delete(h as number) } },
    fire: () => { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn() },
    count: () => pending.size,
  }
}
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)) }

interface Sent { kind: 'PUT' | 'POST'; qty: unknown; settle: (ok: boolean, error?: unknown) => void }

/** A harness whose requests the test answers by hand, and a server that keeps the state of the request it applied
 *  last — so a stale request applied after a newer one shows as the wrong final state, not just a wrong log. */
function world() {
  const clock = manualTimers()
  const sent: Sent[] = []
  const placed: string[] = []
  const receipts = new Set<string>()
  let ids = 0
  const server = { qty: 1 as unknown }
  const request = <T>(kind: Sent['kind'], state: UiState, answer: () => T): Promise<T> => {
    const d = deferred<T>()
    sent.push({ kind, qty: state.qty, settle: (ok, error) => { if (ok) { server.qty = state.qty; d.resolve(answer()) } else d.reject(error ?? new Error('network down')) } })
    return d.promise
  }
  const deps: QueueDeps = {
    delay: 400, timers: clock.timers, newId: () => `ui-req-${++ids}`,
    save: (_t, _r, state) => request('PUT', state, () => ({})),
    prepare: (s: ActionSnapshot) => request('POST', s.state, () => ({ receipt_id: `rc-${s.request_id}`, prompt: `[UI action] ${s.action_id} qty=${String(s.state.qty)}` })),
    place: (sessionId, receiptId, prompt) => { if (receipts.has(receiptId)) return false; receipts.add(receiptId); placed.push(`${sessionId}: ${prompt}`); return true },
    isConflict: (e) => (e as { status?: number }).status === 409,
    onConflict: () => undefined,
  }
  const registry = createQueueRegistry()
  const target: SurfaceTarget = { session_id: 's1', run_id: 'r1', surface_id: 'calc' }
  /** a view of the surface (a mounted component): it acquires the shared queue and listens until it unmounts */
  const mount = () => {
    const queue = registry.acquire(target, deps)
    const seen: QueueView[] = []
    const unmount = queue.subscribe((v) => seen.push(v))
    return { queue, seen, unmount }
  }
  const log = () => sent.map((s) => `${s.kind} ${String(s.qty)}`)
  return { clock, sent, placed, server, registry, target, deps, mount, log }
}

test('every view of a surface gets the same queue; another session, run or surface its own; idle and unheard, it is let go', async () => {
  const w = world()
  const a = w.mount()
  const b = w.mount()
  assert.equal(a.queue, b.queue)
  assert.notEqual(w.registry.acquire({ ...w.target, session_id: 's2' }, w.deps), a.queue)
  a.queue.edit({ qty: 2 }, 1)
  a.unmount(); b.unmount()
  assert.equal(w.registry.peek(w.target), a.queue, 'not let go while an edit waits')
  w.clock.fire()
  w.sent[0]!.settle(true)
  await tick()
  assert.equal(w.registry.peek(w.target), undefined, 'let go once idle and unheard')
  assert.equal(w.server.qty, 2)
})

test('a view drawn again (text version and back) shares the queue: an old save on its way lands before the new press', async () => {
  const w = world()
  const first = w.mount()
  first.queue.edit({ qty: 2 }, 1)
  w.clock.fire()                                         // PUT 2 is on its way (slow)
  first.unmount()                                        // "Text version": the view goes
  const again = w.mount()                                // and comes back
  again.queue.edit({ qty: 3 }, 1)
  again.queue.press('order', { state: { qty: 3 }, revision: 1 })
  await tick()
  assert.deepEqual(w.log(), ['PUT 2'], 'the press waits for the save on its way, whichever view sent it')
  w.sent[0]!.settle(true)                                // the old save lands late
  await tick()
  assert.deepEqual(w.log(), ['PUT 2', 'POST 3'])
  w.sent[1]!.settle(true)
  await tick()
  assert.equal(w.server.qty, 3, 'the press is the last word')
  assert.deepEqual(w.placed, ['s1: [UI action] order qty=3'])
})

test('an old save that fails after a newer press was queued never comes back, not even when the view leaves', async () => {
  const w = world()
  const view = w.mount()
  view.queue.edit({ qty: 2 }, 1)
  w.clock.fire()                                         // PUT 2 on its way
  view.queue.edit({ qty: 3 }, 1)
  view.queue.press('order', { state: { qty: 3 }, revision: 1 })
  w.sent[0]!.settle(false)                               // PUT 2: network error
  await tick()
  assert.deepEqual(w.log(), ['PUT 2', 'POST 3'])
  w.sent[1]!.settle(true)                                // POST 3 succeeds
  await tick()
  view.unmount()
  w.clock.fire()
  await tick()
  assert.deepEqual(w.log(), ['PUT 2', 'POST 3'], 'nothing is sent again: the failed PUT 2 was superseded')
  assert.equal(w.server.qty, 3)
  assert.equal(w.registry.size(), 0)
})

test('a press that fails after its view is gone keeps the newest edit and saves it — never the older save on its way', async () => {
  const w = world()
  const view = w.mount()
  view.queue.edit({ qty: 2 }, 1)
  w.clock.fire()                                         // PUT 2 on its way
  view.queue.edit({ qty: 3 }, 1)                         // qty 3, before the pause
  view.queue.press('order', { state: { qty: 3 }, revision: 1 })
  view.unmount()                                         // the person leaves the session
  w.sent[0]!.settle(false)                               // PUT 2 fails
  await tick()
  w.sent[1]!.settle(false)                               // POST 3 fails too
  await tick()
  assert.deepEqual(w.log(), ['PUT 2', 'POST 3', 'PUT 3'], 'the newest edit is saved on its own, once')
  w.sent[2]!.settle(true)
  await tick()
  assert.equal(w.server.qty, 3)
  assert.deepEqual(w.placed, [], 'a failed press puts nothing in the draft')
  assert.equal(w.registry.size(), 0)
})

test('a failed press while a view is on show: the newest edit is held (no loop), shown to a view drawn again, saved on retry', async () => {
  const w = world()
  const view = w.mount()
  view.queue.edit({ qty: 3 }, 1)
  view.queue.press('order', { state: { qty: 3 }, revision: 1 })
  await tick()
  w.sent[0]!.settle(false)
  await tick(8)
  assert.deepEqual(w.log(), ['POST 3'], 'held: not retried by itself')
  assert.equal(view.seen.at(-1)!.action?.phase, 'error')
  const again = w.mount()
  assert.deepEqual(again.queue.view().unconfirmed, { state: { qty: 3 }, revision: 1 }, 'a view drawn again shows the unsaved edit')
  // the same press again (same state): the same key, so the harness answers it once
  const retried = again.queue.press('order', { state: { qty: 3 }, revision: 1 })
  assert.equal(retried.request_id, 'ui-req-1')
  await tick()
  w.sent[1]!.settle(true)
  await tick()
  assert.equal(w.server.qty, 3)
  assert.equal(again.queue.view().unconfirmed, null)
  view.unmount(); again.unmount()
})

test('a press completes into its own session draft after its view is gone, once per receipt', async () => {
  const w = world()
  const view = w.mount()
  view.queue.press('order', { state: { qty: 5 }, revision: 1 })
  view.unmount()
  await tick()
  w.sent[0]!.settle(true)
  await tick()
  assert.deepEqual(w.placed, ['s1: [UI action] order qty=5'])
  // a retry answered with the same receipt places nothing again
  assert.equal(w.deps.place('s1', 'rc-ui-req-1', 'again'), false)
})

test('saves: debounced to the latest state, one at a time; edits after a press go after it', async () => {
  const w = world()
  const view = w.mount()
  view.queue.edit({ qty: 2 }, 1)
  view.queue.edit({ qty: 3 }, 1)
  assert.deepEqual(w.log(), [])
  w.clock.fire()
  assert.deepEqual(w.log(), ['PUT 3'])
  view.queue.press('order', { state: { qty: 3 }, revision: 1 })
  view.queue.edit({ qty: 4 }, 1)
  w.clock.fire()
  await tick()
  assert.deepEqual(w.log(), ['PUT 3'], 'one request at a time')
  w.sent[0]!.settle(true); await tick()
  assert.deepEqual(w.log(), ['PUT 3', 'POST 3'])
  w.sent[1]!.settle(true); await tick()
  assert.deepEqual(w.log(), ['PUT 3', 'POST 3', 'PUT 4'], 'the edit after the press goes after it')
  w.sent[2]!.settle(true); await tick()
  assert.equal(w.server.qty, 4)
  assert.equal(view.seen.at(-1)!.status.kind, 'saved')
  view.unmount()
})

test('a refused revision (409) drops edits of that revision; the surface is read again', async () => {
  const w = world()
  let conflicts = 0
  w.deps.onConflict = () => { conflicts += 1 }
  const view = w.mount()
  view.queue.edit({ qty: 2 }, 1)
  w.clock.fire()
  w.sent[0]!.settle(false, Object.assign(new Error('republished'), { status: 409 }))
  await tick()
  assert.equal(view.seen.at(-1)!.status.kind, 'conflict')
  assert.equal(conflicts, 1)
  assert.ok(!view.queue.busy())
  view.unmount()
  await tick()
  assert.deepEqual(w.log(), ['PUT 2'])
})

test('regression: an old revision\'s save still on its way never becomes the state of a press on the new revision', async () => {
  const w = world()
  let conflicts = 0
  w.deps.onConflict = () => { conflicts += 1 }
  const old = w.mount()
  old.queue.edit({ qty: 7 }, 1)                          // the person edits revision 1
  w.clock.fire()                                         // PUT 7 (rev 1) on its way, held by a slow server
  old.unmount()                                          // the agent republishes: the rev-1 view goes
  const fresh = w.mount()                                // the rev-2 view finds the same, still busy, queue
  assert.equal(fresh.queue, old.queue)
  assert.ok(fresh.queue.busy())
  // the rev-2 view masks the rev-1 edit and shows its own state; the press must carry exactly that
  const pressed = fresh.queue.press('order', { state: { qty: 2 }, revision: 2 })
  assert.equal(pressed.revision, 2, 'the press is at the revision on show')
  assert.deepEqual(pressed.state, { qty: 2 }, 'the press carries the state on show, not the old revision\'s edit')
  await tick()
  assert.deepEqual(w.log(), ['PUT 7'], 'still one request at a time')
  w.sent[0]!.settle(false, Object.assign(new Error('republished'), { status: 409 }))  // the old save is refused
  await tick()
  assert.equal(conflicts, 1)
  assert.deepEqual(w.log(), ['PUT 7', 'POST 2'], 'the press goes after, with its own snapshot')
  w.sent[1]!.settle(true)
  await tick()
  assert.deepEqual(w.placed, ['s1: [UI action] order qty=2'])
  assert.equal(fresh.queue.view().unconfirmed, null, 'nothing of revision 1 is offered again')
  await tick(); w.clock.fire(); await tick()
  assert.deepEqual(w.log(), ['PUT 7', 'POST 2'], 'the rev-1 edit is never sent again')
  fresh.unmount()
})

test('regression: an old revision\'s save that fails (not 409) is not revived over a press on the new revision', async () => {
  const w = world()
  const view = w.mount()
  view.queue.edit({ qty: 7 }, 1)
  w.clock.fire()                                         // PUT 7 (rev 1) on its way
  const pressed = view.queue.press('order', { state: { qty: 2 }, revision: 2 })
  assert.deepEqual([pressed.revision, pressed.state], [2, { qty: 2 }])
  w.sent[0]!.settle(false)                               // network error on the old save
  await tick()
  w.sent[1]!.settle(true)
  await tick(); w.clock.fire(); await tick()
  assert.deepEqual(w.log(), ['PUT 7', 'POST 2'])
  assert.deepEqual(w.placed, ['s1: [UI action] order qty=2'])
  view.unmount()
})

test('regression: after a confirmed edit, a newer server state of the same revision is what a press carries', async () => {
  const w = world()
  const view = w.mount()
  view.queue.edit({ qty: 5 }, 1)
  w.clock.fire()
  w.sent[0]!.settle(true)                                // PUT 5 confirmed
  await tick()
  assert.equal(view.queue.view().unconfirmed, null)
  // the harness then reports a newer state of the same revision (another tab, the agent's own state): the view shows 9
  const pressed = view.queue.press('order', { state: { qty: 9 }, revision: 1 })
  assert.deepEqual(pressed.state, { qty: 9 }, 'the displayed current value, not the confirmed older edit')
  await tick()
  w.sent[1]!.settle(true)
  await tick()
  assert.deepEqual(w.log(), ['PUT 5', 'POST 9'])
  assert.deepEqual(w.placed, ['s1: [UI action] order qty=9'])
  view.unmount()
})

test('a current-revision edit not yet confirmed is still what a press carries (a second view of the surface)', async () => {
  const w = world()
  const a = w.mount()
  const b = w.mount()
  a.queue.edit({ qty: 6 }, 1)                            // edited in view a, the save still waits for the pause
  const pressed = b.queue.press('order', { state: { qty: 1 }, revision: 1 })  // view b still shows the record's 1
  assert.deepEqual(pressed.state, { qty: 6 }, 'the person\'s unconfirmed edit of this revision is not lost')
  w.clock.fire(); await tick()
  assert.deepEqual(w.log(), ['POST 6'], 'the press carries the edit: no separate save')
  w.sent[0]!.settle(true); await tick()
  assert.equal(w.server.qty, 6)
  a.unmount(); b.unmount()
})
