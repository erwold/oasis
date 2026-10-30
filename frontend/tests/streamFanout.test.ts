/** A session of several agents streaming at once, drawn by React DOM into an in-memory page through the store as the
 *  app drives it (openSession → the session's one stream → each run's watch → the thread): every run's words and tool
 *  calls land in its own turn, in the order they came; and a delta for one run draws that run's turn alone — no other
 *  run's turn, nor the desk beside the thread, nor the images and records under another turn's rows. A run that ends
 *  shows its end, and its bot settles by its own timer (a turn no longer drawn again by its neighbours' deltas still
 *  plays its ending out).
 *
 *  Renders are counted by component name from the commits React reports to a DevTools hook, by DevTools' own rule (a
 *  component fiber that performed work, the subtree skipped where the child pointer is unchanged): counts, never
 *  timings. The page's clock, timers and animation frames are the test's (node:test mock timers, a frame queue): time
 *  moves and a frame is drawn only when the test says so, so what is counted between two steps, and when an ending
 *  settles, does not depend on how fast the host runs. */

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { after, before, test, mock } from 'node:test'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import type { Run, SessionDetail, SSEItem } from '../src/api/types.ts'
import type { ThreadEntry } from '../src/state/thread.ts'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) { const u = new URL(`${specifier}${ext}`, context.parentURL); if (existsSync(u)) return next(u.href, context) }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg|webp)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true }
    return next(url, context)
  },
})

/** An EventSource the test drives (the session's one stream). */
class FakeSource {
  static made: FakeSource[] = []
  readonly listeners = new Map<string, ((event: unknown) => void)[]>()
  closed = false
  readonly url: string
  constructor(url: string) { this.url = url; FakeSource.made.push(this) }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  removeEventListener() {}
  close() { this.closed = true }
  emit(type: string, data: unknown, lastEventId = '') { for (const l of this.listeners.get(type) ?? []) l({ type, data: JSON.stringify(data), lastEventId }) }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://ui.invalid/', pretendToBeVisual: true })
class NoResize { observe() {} unobserve() {} disconnect() {} }
const w = dom.window as unknown as Record<string, unknown>
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: NoResize, EventSource: FakeSource,
  IS_REACT_ACT_ENVIRONMENT: false, __OASIS_CODE_BUILD__: 'test' })
Object.assign(w, { ResizeObserver: NoResize, EventSource: FakeSource })

// ---- the clock and the frames: moved by the test alone ----------------------------------------------------------
const realImmediate = setImmediate
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-18T00:01:00.000Z') })
// the page's own timers (window.setTimeout, as components call them) are the mocked ones too
Object.assign(w, {
  setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms), clearTimeout: (h: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(h),
  setInterval: (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms), clearInterval: (h: ReturnType<typeof setInterval>) => globalThis.clearInterval(h),
})
const queuedFrames = new Map<number, (t: number) => void>()
let nextFrameId = 1
const requestFrame = (cb: (t: number) => void) => { const id = nextFrameId++; queuedFrames.set(id, cb); return id }
const cancelFrame = (id: number) => { queuedFrames.delete(id) }
Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.assign(w, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
/** Let the page's queued work run (promises, React's scheduled renders and effects) without moving the clock: event
 *  loop turns, never time. */
async function drain(turns = 40) { for (let i = 0; i < turns; i += 1) await new Promise((r) => realImmediate(r)) }
/** One frame: the frame callbacks asked for before it (each followed by its microtasks and React's work), then the
 *  clock moves on by a frame's 16 ms (a timer due by then fires), then the page's work runs out. */
async function frame() {
  for (const id of [...queuedFrames.keys()]) {
    const cb = queuedFrames.get(id)
    queuedFrames.delete(id)
    if (cb) { cb(Date.now()); await drain(4) }
  }
  mock.timers.tick(16)
  await drain()
}
/** Frames until `ok` holds; the bound only guards a fixture that hangs (it counts frames, never time). */
async function framesUntil(what: string, ok: () => boolean, bound = 200) {
  for (let n = 0; !ok(); n += 1) {
    if (n >= bound) assert.fail(`${what}: not reached in ${bound} frames`)
    await frame()
  }
}
if (typeof w.matchMedia !== 'function') w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
// nothing here leaves the process: a read no mock below answers is refused, as a backend that does not serve it would
const unserved: string[] = []
globalThis.fetch = (async (input: unknown) => {
  unserved.push(String(input))
  return new Response(JSON.stringify({ detail: 'not served by this test' }), { status: 404, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

// ---- render counts (DevTools hook protocol, installed before React DOM loads) -------------------------------------
type Fiber = { tag: number; type: unknown; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null }
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
const PERFORMED_WORK = 1
const nameOf = (f: Fiber): string => {
  const t = f.type as { displayName?: string; name?: string; type?: { displayName?: string; name?: string }; render?: { displayName?: string; name?: string } } | null
  if (!t) return '?'
  return t.displayName || t.name || t.type?.displayName || t.type?.name || t.render?.displayName || t.render?.name || '?'
}
let renders = new Map<string, number>()
let commits = 0
const countCommit = (root: Fiber) => {
  const stack = [root]
  while (stack.length) {
    const f = stack.pop()!
    if (COMPONENT_TAGS.has(f.tag) && (f.alternate === null || (f.flags & PERFORMED_WORK) === PERFORMED_WORK)) renders.set(nameOf(f), (renders.get(nameOf(f)) ?? 0) + 1)
    if (f.alternate && f.child === f.alternate.child) continue
    for (let c = f.child; c; c = c.sibling) stack.push(c)
  }
}
let rid = 0
Object.assign(globalThis, { __REACT_DEVTOOLS_GLOBAL_HOOK__: {
  supportsFiber: true, renderers: new Map(), isDisabled: false, checkDCE() {},
  inject(r: unknown) { rid += 1; (this as { renderers: Map<number, unknown> }).renderers.set(rid, r); return rid },
  onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, setStrictMode() {},
  onCommitFiberRoot(_id: number, root: { current: Fiber }) { commits += 1; countCommit(root.current) },
} })
const rendered = (name: string) => renders.get(name) ?? 0
const resetCounts = () => { renders = new Map(); commits = 0 }

const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { RunSchema } = await import('@oasis-code/contract')
const { useStore } = await import('../src/state/store.ts')
const { api } = await import('../src/api/client.ts')
const { applyEvent } = await import('../src/state/thread.ts')
const { DONE_MS } = await import('../src/state/outline.ts')
const { Thread } = await import('../src/components/Thread.tsx')

// ---- the session: N live agents, each streaming words and tool rounds, interleaved ------------------------------
const AGENTS = 6
const ROUNDS = 4
const WORDS = 3
const NOW = '2026-10-18T00:00:00.000Z'
const runId = (i: number) => `run_fan_${i}`
const runIds = Array.from({ length: AGENTS }, (_, i) => runId(i))
const finished = new Map<string, Record<string, unknown>>()
const runOf = (id: string): Run => ({ ...RunSchema.parse({ id, session_id: 's_fan', project_id: 'p_fan', workspace_id: null, model: 'scripted:a', user_text: `${id}: keep working`, status: 'running', created_at: NOW }), ...(finished.get(id) ?? {}) } as unknown as Run)
const detail = (): SessionDetail => ({
  id: 's_fan', project_id: 'p_fan', model: 'scripted:a', title: `${AGENTS} agents streaming`, workspace: null, created_at: NOW, updated_at: NOW,
  runs: runIds.map(runOf), director: null, interactions: [], relays: [], director_notes: [], active_run: null, active_children: [], active_runs: [],
  watches: [], wake_events: [], run_count: AGENTS, pending_approvals: [], event_cursor: 0,
} as unknown as SessionDetail)

/** The events of agent `i`, in its order: a block of `WORDS` deltas, then a read_file round, `ROUNDS` times. */
function eventsOf(i: number): { event: string; data: Record<string, unknown> }[] {
  const out: { event: string; data: Record<string, unknown> }[] = []
  for (let r = 0; r < ROUNDS; r += 1) {
    for (let k = 0; k < WORDS; k += 1) out.push({ event: 'text_delta', data: { text: ` a${i}r${r}w${k}`, ...(k === 0 ? { start: true } : {}) } })
    const call = `${runId(i)}-call-${r}`
    out.push({ event: 'tool_call', data: { tool: 'read_file', tool_call_id: call, summary: `read src/a${i}_r${r}.ts`, path: `src/a${i}_r${r}.ts` } })
    out.push({ event: 'tool_result', data: { tool: 'read_file', tool_call_id: call, status: 'ok' } })
  }
  return out
}

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let stream: FakeSource
let cursor = 0
const seqOf = new Map<string, number>()
const sent = new Map<string, SSEItem[]>(runIds.map((id) => [id, []]))
function send(id: string, event: string, data: Record<string, unknown>) {
  const seq = (seqOf.get(id) ?? 0) + 1
  seqOf.set(id, seq)
  sent.get(id)!.push({ event, data, id: String(seq) } as SSEItem)
  stream.emit(event, { run_id: id, seq, data }, String(++cursor))
}
const turnOf = (id: string) => host.querySelector<HTMLElement>(`[data-testid="run-${id}"]`)

before(async () => {
  for (const key of ['refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'syncSession', 'loadDirector', 'loadAccess', 'loadSessionActivity'] as const) useStore.setState({ [key]: async () => {} })
  mock.method(api, 'session', async () => detail())
  mock.method(api, 'run', async (id: string) => runOf(id))
  mock.method(api, 'runEventsPage', async (id: string) => ({ run_id: id, session_id: 's_fan', events: [] }))
  mock.method(api, 'steers', async () => ({ steers: [] }))
  mock.method(api, 'tree', async () => ({ session_id: 's_fan', runs: [] }))
  mock.method(api, 'collaboration', async () => { throw Object.assign(new Error('Not Found'), { status: 404 }) })
  await useStore.getState().openSession('s_fan')
  await drain()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  root.render(createElement(Thread))
  await frame()
  const open = FakeSource.made.filter((s) => !s.closed)
  assert.equal(open.length, 1, 'one stream for the session')
  stream = open[0]!
  // the server's replay, then ready
  for (const id of runIds) send(id, 'run_started', { model: 'scripted:a' })
  stream.emit('stream_ready', { cursor, live_runs: runIds }, String(cursor))
  await framesUntil('every turn drawn', () => runIds.every((id) => turnOf(id) !== null))
  // the agents at work at once: one event of each in turn, a tick at a time
  const streams = runIds.map((_, i) => eventsOf(i))
  for (let step = 0; step < streams[0]!.length; step += 1) {
    for (const [i, id] of runIds.entries()) { const e = streams[i]![step]!; send(id, e.event, e.data) }
    await frame()
  }
  await framesUntil('every run\'s last round in its thread', () => runIds.every((id) => (useStore.getState().threads[id] ?? []).filter((e) => e.kind === 'activity' && !e.running).length === ROUNDS))
  await frame()
})

after(async () => {
  root?.unmount()
  useStore.getState().closeSession()
  mock.timers.reset()
  mock.restoreAll()
})

test('each run\'s rows are its own events applied in the order they came; its turn shows its words and tool rounds in that order', () => {
  const threads = useStore.getState().threads
  for (const id of runIds) {
    const expected = sent.get(id)!.reduce<ThreadEntry[]>((rows, item) => applyEvent(rows, id, item), [])
    assert.deepEqual(threads[id], expected, `${id}: rows as its events, in order`)
    const turn = turnOf(id)!
    const text = turn.textContent ?? ''
    const i = runIds.indexOf(id)
    // every word and every round, in the order the run said them
    const marks: string[] = []
    for (let r = 0; r < ROUNDS; r += 1) { for (let k = 0; k < WORDS; k += 1) marks.push(`a${i}r${r}w${k}`); marks.push(`src/a${i}_r${r}.ts`) }
    let at = -1
    for (const mark of marks) {
      const next = text.indexOf(mark, at + 1)
      assert.ok(next > at, `${id}: "${mark}" after what came before it`)
      at = next
    }
    // no other agent's words in this turn
    for (const other of runIds) if (other !== id) assert.equal(text.includes(`a${runIds.indexOf(other)}r0w0`), false, `${id} holds no words of ${other}`)
    const rows = [...turn.querySelectorAll<HTMLElement>('[data-tool="read_file"]')]
    assert.equal(rows.length, ROUNDS, `${id}: one row per round`)
    assert.ok(rows.every((row) => row.dataset.status === 'ok'), `${id}: every round finished ok`)
    assert.ok(turn.querySelector('[data-testid="live-line"]'), `${id}: still live`)
  }
})

test('a delta for one run draws that run\'s turn alone: no other turn, not the desk, not the images and records under other rows', async () => {
  const target = runIds[2]!
  // the counter sees these components by these names when they do draw: every turn and the desk drew as the page opened
  assert.ok(rendered('RunTurn') >= AGENTS, `turns counted as they mounted: ${rendered('RunTurn')}`)
  assert.ok(rendered('Desk') >= 1, `the desk counted as it mounted: ${rendered('Desk')}`)
  resetCounts()
  send(target, 'text_delta', { text: ' probe-word' })
  // the frame that applies it, and one more: nothing else is due in either (the clock moves 32 ms, no timer of the page waits that short)
  await frame()
  await frame()
  assert.ok((turnOf(target)?.textContent ?? '').includes('probe-word'), 'the probe word on the page')
  const counts = Object.fromEntries([...renders.entries()].sort((a, b) => b[1] - a[1]))
  assert.ok(commits >= 1, 'the delta was committed')
  assert.equal(rendered('Thread'), 1, `the thread drew once for the delta (${JSON.stringify(counts)})`)
  assert.equal(rendered('RunTurn'), 1, `turns drawn for one run's delta, of ${AGENTS}: ${rendered('RunTurn')} (${JSON.stringify(counts)})`)
  assert.equal(rendered('Desk'), 0, `the desk drew for a delta it does not show: ${rendered('Desk')}`)
  assert.equal(rendered('ShownImages'), 0, `images under unchanged rows drew again: ${rendered('ShownImages')}`)
  assert.equal(rendered('Row'), 0, `unchanged rows drew again: ${rendered('Row')}`)
  // the other runs' turns still stand as they were
  for (const id of runIds) if (id !== target) assert.equal((turnOf(id)?.textContent ?? '').includes('probe-word'), false)
  // and the desk is counted when something it reads changes (the run tree, read again)
  resetCounts()
  useStore.setState({ tree: [] })
  await frame()
  assert.ok(rendered('Desk') >= 1, `the desk drew for the tree it reads: ${rendered('Desk')}`)
})

test('a run that ends shows its end, and its bot settles by its own timer; the other runs stay live', async () => {
  const target = runIds[4]!
  // ended now (the test's clock): its bot plays the end for DONE_MS, then goes still by its own timer
  const finishedAt = new Date(Date.now()).toISOString()
  finished.set(target, { status: 'done', finished_at: finishedAt })
  send(target, 'run_finished', { status: 'done', finished_at: finishedAt })
  await framesUntil('the ended run drawn as done', () => turnOf(target)?.dataset.status === 'done' && !turnOf(target)!.querySelector('[data-testid="live-line"]'))
  // the turn's latest words carry its state; what it said before stands still
  const bots = () => [...turnOf(target)!.querySelectorAll<HTMLElement>('img.turn-bot')]
  const bot = () => bots().at(-1)
  assert.equal(bot()?.dataset.botState, 'done', 'the bot plays the end')
  assert.ok(bots().slice(0, -1).every((b) => b.dataset.botState === 'static'), 'earlier words stand still')
  // short of the settle time it still plays it; past it, with no event and no store change, its own timer stills it
  mock.timers.tick(DONE_MS - 1_000)
  await drain()
  assert.equal(bot()?.dataset.botState, 'done', 'still playing the end before DONE_MS')
  mock.timers.tick(1_000 + 100)
  await drain()
  assert.equal(bot()?.dataset.botState, 'static', 'settled by its own timer once DONE_MS passed')
  for (const id of runIds) if (id !== target) {
    assert.ok(turnOf(id)!.querySelector('[data-testid="live-line"]'), `${id} still live`)
    assert.equal(turnOf(id)!.dataset.status, 'running')
  }
})
