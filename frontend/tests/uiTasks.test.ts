import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uiTaskResult, type UiTaskRecord, type UiTaskUpdate } from '@oasis-code/contract'
import { createQueueRegistry, type QueueDeps, type SurfaceTarget } from '../src/state/uiQueue.ts'
import type { ActionSnapshot, UiState } from '../src/state/uiSurface.ts'
import { createSurfaceTasks, type TaskDeps, type TaskRunEvent, type TasksView } from '../src/state/uiTasks.ts'

const tick = () => new Promise((r) => setImmediate(r))
const target: SurfaceTarget = { session_id: 's1', run_id: 'r1', surface_id: 'calc' }

let clock = 0
const at = () => new Date(Date.UTC(2026, 9, 12, 0, 0, 0, ++clock)).toISOString()
function task(over: Partial<UiTaskRecord> = {}): UiTaskRecord {
  return {
    id: 'uit_1', session_id: 's1', surface_run_id: 'r1', surface_id: 'calc', revision: 1, action_id: 'order', request_id: 'ui-req-1',
    agent_run_id: null, status: 'queued', input: null, text: '', data: null, error: null,
    created_at: '2026-10-12T00:00:00.000Z', started_at: null, finished_at: null, updated_at: at(), ...over,
  }
}

function manualTimers() {
  let next = 1
  const due = new Map<number, () => void>()
  return {
    timers: { set: (fn: () => void) => { const id = next++; due.set(id, fn); return id }, clear: (h: unknown) => { due.delete(h as number) } },
    pending: () => due.size,
    fire: () => { const fns = [...due.values()]; due.clear(); for (const f of fns) f() },
  }
}

/** A harness the test speaks for: the task's record as GET answers it, the run streams the test drives. */
function harness() {
  const clockT = manualTimers()
  let record: UiTaskRecord | null = null
  const gets: string[] = []
  const streams: Array<{ runId: string; after: number | null; emit: (e: TaskRunEvent) => void; close: () => void; disposed: boolean }> = []
  let listed: UiTaskRecord[] = []
  let cancelAnswer: (() => UiTaskRecord) | null = null
  let getError: unknown = null
  const deps: TaskDeps = {
    timers: clockT.timers, pollMs: 1000,
    list: async () => listed,
    get: async (_s, id) => { gets.push(id); if (getError) throw getError; return record! },
    cancel: async () => cancelAnswer!(),
    follow: (runId, after, onEvent, onClose) => {
      const s = { runId, after, emit: onEvent, close: onClose, disposed: false }
      streams.push(s)
      return () => { s.disposed = true }
    },
  }
  return {
    clock: clockT, gets, streams, deps,
    set record(r: UiTaskRecord) { record = r },
    set listed(l: UiTaskRecord[]) { listed = l },
    set cancelAnswer(f: () => UiTaskRecord) { cancelAnswer = f },
    set getError(e: unknown) { getError = e },
  }
}

// ---------------------------------------------------------------- the press: the newest value goes with the click

function queueWorld() {
  const clockQ = manualTimers()
  const log: string[] = []
  const settles: Array<(ok: boolean, error?: unknown) => void> = []
  let ids = 0
  const request = <T>(what: string, answer: () => T): Promise<T> => new Promise<T>((resolve, reject) => {
    log.push(what)
    settles.push((ok, error) => (ok ? resolve(answer()) : reject(error ?? new Error('network down'))))
  })
  const started: Array<{ snapshot: ActionSnapshot; input: unknown }> = []
  const deps: QueueDeps = {
    delay: 450, timers: clockQ.timers, newId: () => `ui-req-${++ids}`,
    save: (_t, _r, state: UiState) => request(`PUT qty=${String(state.qty)}`, () => ({})),
    prepare: () => request('POST actions', () => ({ receipt_id: 'rc', prompt: 'p' })),
    place: () => true,
    startTask: (snapshot, input) => { started.push({ snapshot, input }); return request(`POST tasks qty=${String(snapshot.state.qty)}`, () => ({ task: task() })) },
    isConflict: (e) => (e as { status?: number }).status === 409,
    onConflict: () => undefined,
  }
  const queue = createQueueRegistry().acquire(target, deps)
  queue.subscribe(() => undefined)
  return { queue, log, settles, started, clock: clockQ }
}

test('a value changed and the run button pressed at once: the start carries the new value, and the debounced save of it is folded in', async () => {
  const w = queueWorld()
  // the person types 7 into the quantity and presses the button before the save's pause is over
  w.queue.edit({ qty: 7, price: 4 }, 1)
  const { snapshot, started } = w.queue.launch('order', { state: { qty: 3, price: 4 }, revision: 1 })
  assert.equal(snapshot.state.qty, 7, 'the press takes the newest edit, not the state on show before it')
  assert.deepEqual(w.log, ['POST tasks qty=7'])
  w.clock.fire()
  w.settles[0]!(true)
  await started
  await tick()
  assert.deepEqual(w.log, ['POST tasks qty=7'], 'no save of the same value after the start: the start saved it')
})

test('a run pressed while a save is on its way goes after it, with the newer value', async () => {
  const w = queueWorld()
  w.queue.edit({ qty: 5 }, 1)
  w.clock.fire()
  assert.deepEqual(w.log, ['PUT qty=5'])
  w.queue.edit({ qty: 6 }, 1)
  void w.queue.launch('order', { state: { qty: 1 }, revision: 1 }).started
  assert.deepEqual(w.log, ['PUT qty=5'], 'the start waits for the save already on its way')
  w.settles[0]!(true)
  await tick(); await tick()
  assert.deepEqual(w.log, ['PUT qty=5', 'POST tasks qty=6'])
})

test('a refused start: the values go out as a save of their own; an identical retry keeps its key, a changed one gets a new one', async () => {
  const w = queueWorld()
  w.queue.edit({ qty: 8 }, 1)
  const first = w.queue.launch('order', { state: { qty: 1 }, revision: 1 }, { rows: 2 })
  w.settles[0]!(false, Object.assign(new Error('network down'), { status: 0 }))
  await assert.rejects(first.started)
  await tick()
  assert.deepEqual(w.log, ['POST tasks qty=8', 'PUT qty=8'], 'the values the refused start carried are saved')
  w.settles[1]!(true)
  await tick()
  const again = w.queue.launch('order', { state: { qty: 8 }, revision: 1 }, { rows: 2 })
  assert.equal(again.snapshot.request_id, first.snapshot.request_id, 'the same press again: the same key (the harness answers it once)')
  w.settles[2]!(false); await assert.rejects(again.started); await tick()
  const other = w.queue.launch('order', { state: { qty: 8 }, revision: 1 }, { rows: 3 })
  assert.notEqual(other.snapshot.request_id, first.snapshot.request_id, 'another input is another request')
})

// ---------------------------------------------------------------- the task: the harness's record is the truth

test('queued: asked for every second while watched; running: its run followed; text, tools, data, done — and the Promise resolves', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  const updates: UiTaskUpdate[] = []
  tasks.onUpdate((u) => updates.push(u))
  await tick()
  const queued = task()
  const result = tasks.run('order', async () => ({ task: queued }))
  await tick()
  assert.deepEqual(updates.map((u) => u.type), ['status'])
  assert.equal(h.clock.pending(), 1, 'a queued task is asked for again after a while')
  // still queued at the first ask; running with its run at the second
  h.record = { ...queued, updated_at: queued.updated_at }
  h.clock.fire(); await tick()
  assert.equal(h.gets.length, 1)
  assert.equal(h.streams.length, 0)
  h.record = task({ status: 'running', agent_run_id: 'run_t', started_at: at() })
  h.clock.fire(); await tick()
  assert.equal(h.streams.length, 1, 'the run is followed once it exists')
  assert.equal(h.streams[0]!.runId, 'run_t')
  assert.equal(h.streams[0]!.after, null, 'from its start')
  assert.equal(h.clock.pending(), 0, 'no more asking while the stream speaks')
  const s = h.streams[0]!
  s.emit({ event: 'text_delta', data: { text: 'Look', start: true }, id: '3' })
  s.emit({ event: 'text_delta', data: { text: 'ing up' }, id: '4' })
  s.emit({ event: 'tool_call', data: { tool: 'read_file', summary: '{"path":"prices.csv"}', tool_call_id: 'c1' }, id: '5' })
  s.emit({ event: 'ui_task', data: { task: task({ status: 'running', agent_run_id: 'run_t', data: { total: 21 } }) }, id: '6' })
  s.emit({ event: 'ui_task', data: { task: task({ status: 'succeeded', agent_run_id: 'run_t', data: { total: 21 }, text: 'Total is 21.', finished_at: at() }) }, id: '7' })
  s.emit({ event: 'run_finished', data: { status: 'done' }, id: '8' })
  const r = await result
  assert.deepEqual(r, { ok: true, task_id: 'uit_1', status: 'succeeded', text: 'Total is 21.', data: { total: 21 }, error: null })
  assert.deepEqual(updates.map((u) => u.type), ['status', 'status', 'text', 'text', 'tool', 'data', 'done'])
  assert.deepEqual(updates.filter((u) => u.type === 'text').map((u) => (u as { text: string }).text), ['Look', 'Looking up'])
  assert.deepEqual(updates.find((u) => u.type === 'tool'), { type: 'tool', task_id: 'uit_1', action_id: 'order', name: 'read_file', summary: '{"path":"prices.csv"}' })
  assert.ok(s.disposed, 'the stream is let go when the task ended')
  const view = tasks.view().tasks[0]!
  assert.equal(view.text, 'Total is 21.', 'the final answer replaces the streamed words')
  assert.equal(h.gets.length, 2, 'the end came with the stream: nothing asked after')
})

test("a run that ends without the task's terminal record: the task is asked for, never ended by the stream alone", async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  tasks.subscribe(() => undefined)
  const running = task({ status: 'running', agent_run_id: 'run_t' })
  const result = tasks.run('order', async () => ({ task: running }))
  await tick()
  h.record = task({ status: 'failed', agent_run_id: 'run_t', error: { code: 'run_error', message: 'provider down' }, finished_at: at() })
  h.streams[0]!.emit({ event: 'run_finished', data: { status: 'error' }, id: '9' })
  const r = await result
  assert.equal(r.ok, false)
  assert.equal(r.status, 'failed')
  assert.deepEqual(r.error, { code: 'run_error', message: 'provider down' })
  assert.deepEqual(h.gets, ['uit_1'])
})

test('a stream that closes (the run is over) while the record still says running: asked again until the harness says how it ended', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  tasks.subscribe(() => undefined)
  const result = tasks.run('order', async () => ({ task: task({ status: 'running', agent_run_id: 'run_t' }) }))
  await tick()
  h.record = task({ status: 'running', agent_run_id: 'run_t' })
  h.streams[0]!.close()
  await tick()
  assert.equal(h.gets.length, 1)
  assert.equal(h.clock.pending(), 1, 'asked again later; the stream is not opened again for a run that is over')
  h.record = task({ status: 'cancelled', agent_run_id: 'run_t', finished_at: at() })
  h.clock.fire()
  const r = await result
  assert.equal(r.status, 'cancelled')
  assert.equal(h.streams.length, 1)
})

test('a task the harness no longer knows (404): its Promise resolves failed, no endless wait', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  tasks.subscribe(() => undefined)
  const result = tasks.run('order', async () => ({ task: task() }))
  await tick()
  h.getError = Object.assign(new Error('not found'), { status: 404, detail: 'no such task', body: { detail: 'no such task', error: 'not_found' } })
  h.clock.fire()
  const r = await result
  assert.equal(r.status, 'failed')
  assert.equal(r.error?.code, 'not_found')
  assert.equal(h.clock.pending(), 0)
})

test('a refused start resolves `refused` with the route\'s code (no task); the active task it names is shown', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  tasks.subscribe(() => undefined)
  const active = task({ id: 'uit_0', status: 'running', agent_run_id: 'run_0' })
  const r = await tasks.run('order', async () => {
    throw Object.assign(new Error('409'), { status: 409, detail: 'a task of this surface is under way', body: { detail: 'a task of this surface is under way', error: 'task_active', task: active } })
  })
  assert.deepEqual(r, { ok: false, task_id: null, status: 'refused', text: '', data: null, error: { code: 'task_active', message: 'a task of this surface is under way' } })
  const view: TasksView = tasks.view()
  assert.equal(view.refused?.result.error?.code, 'task_active')
  assert.equal(view.tasks[0]?.record.id, 'uit_0', 'the task under way is on show, with its Stop')
  assert.equal(h.streams[0]?.runId, 'run_0', 'and followed')
})

test('a start answered with an earlier task that already ended (the same request again) resolves at once with its result', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  const done = task({ status: 'succeeded', agent_run_id: 'run_t', text: 'ok', data: [1], finished_at: at() })
  assert.deepEqual(await tasks.run('order', async () => ({ task: done })), uiTaskResult(done))
})

test('Stop: a queued task the harness cancels ends cancelled; the stop is true; a stop of an unknown or ended task is false', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  const updates: UiTaskUpdate[] = []
  tasks.onUpdate((u) => updates.push(u))
  const result = tasks.run('order', async () => ({ task: task() }))
  await tick()
  h.cancelAnswer = () => task({ status: 'cancelled', finished_at: at() })
  assert.equal(await tasks.stop('uit_1'), true)
  assert.equal((await result).status, 'cancelled')
  assert.equal(updates.at(-1)?.type, 'done')
  assert.equal(await tasks.stop('uit_1'), false, 'ended already')
  assert.equal(await tasks.stop('uit_x'), false, 'not this surface\'s')
})

test('a record older than the one held (a replayed event, a list read before) changes nothing; another surface\'s is not taken', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  const updates: UiTaskUpdate[] = []
  tasks.onUpdate((u) => updates.push(u))
  const older = task({ status: 'running', agent_run_id: 'run_t' })
  const newer = task({ status: 'running', agent_run_id: 'run_t', data: { v: 2 } })
  tasks.adopt(newer)
  tasks.adopt(older)
  assert.deepEqual(tasks.view().tasks[0]!.record.data, { v: 2 })
  tasks.adopt(task({ id: 'uit_9', surface_id: 'other' }))
  assert.equal(tasks.view().tasks.length, 1)
  assert.deepEqual(updates.map((u) => u.type), ['status', 'data'])
})

test('after a refresh (a new page): the surface lists its tasks — one under way is followed from its start, one that ended is history (no done said again)', async () => {
  const h = harness()
  h.listed = [
    task({ id: 'uit_2', status: 'running', agent_run_id: 'run_2', created_at: '2026-10-12T00:00:02.000Z', data: { rows: 1 } }),
    task({ id: 'uit_1', status: 'succeeded', agent_run_id: 'run_1', text: 'First answer', data: { rows: 0 }, finished_at: at() }),
  ]
  const tasks = createSurfaceTasks(target, h.deps)
  const updates: UiTaskUpdate[] = []
  tasks.onUpdate((u) => updates.push(u))
  await tick()
  assert.deepEqual(h.streams.map((s) => [s.runId, s.after]), [['run_2', null]])
  assert.ok(!updates.some((u) => u.task_id === 'uit_1'), 'nothing said of a task that ended before')
  h.streams[0]!.emit({ event: 'text_delta', data: { text: 'Second', start: true }, id: '4' })
  const views = tasks.views()
  assert.deepEqual(views.map((v) => [v.task_id, v.status, v.text]), [['uit_2', 'running', 'Second'], ['uit_1', 'succeeded', 'First answer']])
  // a frame that says ready now is told what is under way, first
  assert.deepEqual(tasks.current().map((u) => u.type), ['status', 'text', 'data'])
})

test('nobody watching: the stream is let go; watched again it goes on after the last event delivered (nothing twice)', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  const stopView = tasks.subscribe(() => undefined)
  tasks.adopt(task({ status: 'running', agent_run_id: 'run_t' }))
  const first = h.streams[0]!
  first.emit({ event: 'text_delta', data: { text: 'Hello', start: true }, id: '11' })
  stopView()
  assert.ok(first.disposed, 'a session left: its streams are let go')
  h.listed = []
  tasks.subscribe(() => undefined)
  await tick()
  assert.equal(h.streams.length, 2)
  assert.equal(h.streams[1]!.after, 11, 'picked up after the last event')
  h.streams[1]!.emit({ event: 'text_delta', data: { text: ' world' }, id: '12' })
  assert.equal(tasks.view().tasks[0]!.text, 'Hello world')
})

test('a queued task nobody watches is not asked for; watched again, it is', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  tasks.adopt(task())
  assert.equal(h.clock.pending(), 0, 'no view, no frame, no waiting run(): no polling')
  const stop = tasks.subscribe(() => undefined)
  assert.equal(h.clock.pending(), 1)
  stop()
  assert.equal(h.clock.pending(), 0)
})

test('return_ui_result replacing the data while the run goes on: each replacement is said at once — null (cleared) included; the same value again, and no data at all, say nothing', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  const updates: UiTaskUpdate[] = []
  tasks.onUpdate((u) => updates.push(u))
  await tick()
  const result = tasks.run('order', async () => ({ task: task({ status: 'running', agent_run_id: 'run_t' }) }))
  await tick()
  assert.deepEqual(updates.map((u) => u.type), ['status'], 'a task with no data yet: nothing about data')
  const s = h.streams[0]!
  const running = (data: unknown) => task({ status: 'running', agent_run_id: 'run_t', data })
  s.emit({ event: 'ui_task', data: { task: running({ rows: [1, 2] }) }, id: '3' })
  s.emit({ event: 'ui_task', data: { task: running({ rows: [1, 2] }) }, id: '4' })   // the same data sent again
  s.emit({ event: 'ui_task', data: { task: running(null) }, id: '5' })              // cleared
  s.emit({ event: 'ui_task', data: { task: running(null) }, id: '6' })              // cleared again
  const live = updates.filter((u) => u.type === 'data').map((u) => (u as { data: unknown }).data)
  assert.deepEqual(live, [{ rows: [1, 2] }, null], 'the clearing reached the listener while the task still ran')
  assert.ok(!updates.some((u) => u.type === 'done'), 'not left to the end to say it')
  assert.equal(tasks.view().tasks[0]!.record.status, 'running')
  assert.equal(tasks.view().tasks[0]!.record.data, null)
  assert.deepEqual(tasks.current().map((u) => u.type), ['status'], 'a frame arriving now is told of no data')
  s.emit({ event: 'ui_task', data: { task: task({ status: 'succeeded', agent_run_id: 'run_t', data: null, text: 'Cleared.', finished_at: at() }) }, id: '7' })
  const r = await result
  assert.equal(r.ok && r.data, null)
  assert.deepEqual(updates.map((u) => u.type), ['status', 'data', 'data', 'done'])
})

test('Stop refused because the run is already writing its end (409 task_finishing): false, no longer stopping, and the task ends as its run does — never as stopped', async () => {
  const h = harness()
  const tasks = createSurfaceTasks(target, h.deps)
  const updates: UiTaskUpdate[] = []
  tasks.onUpdate((u) => updates.push(u))
  const running = task({ status: 'running', agent_run_id: 'run_t', started_at: at() })
  const result = tasks.run('order', async () => ({ task: running }))
  await tick()
  const named = task({ status: 'running', agent_run_id: 'run_t', started_at: running.started_at, text: '' })
  h.cancelAnswer = () => { throw Object.assign(new Error('409'), { status: 409, detail: 'the task\'s run is already ending', body: { detail: 'the task\'s run is already ending', error: 'task_finishing', task: named } }) }
  let seenStopping = false
  const unsub = tasks.subscribe((v) => { if (v.tasks[0]?.stopping) seenStopping = true })
  assert.equal(await tasks.stop('uit_1'), false, 'the stop was not taken')
  assert.ok(seenStopping, 'it said stopping while the request was on its way')
  assert.equal(tasks.view().tasks[0]!.stopping, false, 'and no longer once refused')
  assert.equal(tasks.view().tasks[0]!.record.status, 'running')
  assert.ok(!updates.some((u) => u.type === 'done'), 'nothing ended yet')
  // the run ends as it was going to: the task's own record says succeeded, and the Promise resolves with it
  const s = h.streams.at(-1)!
  assert.equal(s.disposed, false, 'still followed')
  s.emit({ event: 'ui_task', data: { task: task({ status: 'succeeded', agent_run_id: 'run_t', text: 'The total is 9.', data: { total: 9 }, finished_at: at() }) }, id: '7' })
  s.emit({ event: 'run_finished', data: { status: 'done' }, id: '8' })
  const r = await result
  assert.deepEqual(r, { ok: true, task_id: 'uit_1', status: 'succeeded', text: 'The total is 9.', data: { total: 9 }, error: null })
  assert.equal(updates.filter((u) => u.type === 'done').length, 1)
  unsub()
})
