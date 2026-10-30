import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) { const u = new URL(`${specifier}${ext}`, context.parentURL); if (existsSync(u)) return next(u.href, context) }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg|gif|webp)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true }
    return next(url, context)
  },
})
// The rail's dots in a real React tree over an in-memory DOM. The harness is mocked HTTP over a synthetic world of
// sessions (each: its live runs, its ends, its latest done end): the background sessions' word; the store's records
// are the open session's. The mock answers both the activity route and the project list (an earlier build of this
// feature read a session's latest done end from the list), so the same cases show what that build missed. No
// browser, backend or provider.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://ui.invalid/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Image: dom.window.Image, IS_REACT_ACT_ENVIRONMENT: true, __OASIS_CODE_BUILD__: 'test' })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useStore } = await import('../src/state/store.ts')
const { Sidebar } = await import('../src/components/Sidebar.tsx')
// the page's storage as the app leaves it (state/sessionDots.ts SEEN_KEY): read back as a new page would
const SEEN_KEY = 'oasis-code.railSeen.v2'
const readBack = () => { const raw = localStorage.getItem(SEEN_KEY); return raw ? { ready: true, marks: JSON.parse(raw).marks } : { ready: false, marks: {} } }

const T0 = '2026-10-18T09:00:00.000Z'
const T1 = '2026-10-18T10:00:00.000Z'
type Live = { id: string; status: string; spawned_by: string; model: string; slot_waiting: boolean; pending_input: boolean }
/** One session as the harness holds it: its live runs, how many runs ended, and the latest that ended done. */
interface World { live: Live[]; ended: number; lastDone: { at: string; reason?: string } | null }
const initial = { ...useStore.getState() }
const container = document.getElementById('root')!
let root: ReturnType<typeof createRoot>
let world: Record<string, World> = {}
let activityGate: Promise<void> | null = null
let activityReads = 0, activityInFlight = 0, activityMaxInFlight = 0
const quiet = (): World => ({ live: [], ended: 0, lastDone: null })
const w = (o: Partial<World> = {}): World => ({ ...quiet(), ...o })
const running = (id = 'run_x', status = 'running'): Live => ({ id, status, spawned_by: 'human', model: 'm', slot_waiting: false, pending_input: false })
const row = (id: string, title: string) => ({ id, project_id: 'p', title, title_source: 'auto', workspace_id: null, model: 'm', status: 'open', created_at: T0, updated_at: T0, last_activity_at: T0 })
const SESSIONS = [row('s_old', 'Old history'), row('s_bg', 'Background work'), row('s_fail', 'Failed one'), row('s_queue', 'In line')]
const of = (id: string) => world[id] ?? quiet()
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const projectList = () => [{ id: 'p', name: 'app', source_path: '/workspace/app', kind: 'direct', config: {}, created_at: T0, updated_at: T0,
  sessions: SESSIONS.map((s) => {
    const x = of(s.id)
    return { ...s, activity: { live: x.live, director: null, ended: x.ended, last_done: x.lastDone ? { id: 'run_d', status: 'done', finished_at: x.lastDone.at, answer_end_reason: x.lastDone.reason ?? null } : null } }
  }) }]
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
/** The rail's reads, as its ticker makes them: the project list, then the sessions' activity. */
const poll = async () => {
  await act(async () => {
    await useStore.getState().loadProjects()
    const s = useStore.getState() as unknown as { loadSessionActivity?: () => Promise<void> }
    if (s.loadSessionActivity) await s.loadSessionActivity()
  })
  await flush()
}
const dotOf = (id: string) => container.querySelector(`[data-testid="rail-dot-${id}"]`)?.getAttribute('data-dot') ?? null
const detail = (id: string, runs: unknown[] = []) => ({ ...row(id, id), workspace: null, runs, director_notes: [], active_run: null, relays: [], interactions: [], watches: [], wake_events: [], active_children: [], run_count: runs.length, pending_approvals: [], active_runs: [] })
const openSession = async (id: string, runs: unknown[] = []) => { await act(async () => { useStore.setState({ session: detail(id, runs) as never, runs: runs as never }) }); await flush() }
const leave = async () => { await act(async () => { useStore.setState({ session: null, runs: [] }) }); await flush() }
const setVisible = async (visible: boolean) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') })
  await act(async () => { document.dispatchEvent(new dom.window.Event('visibilitychange')) })
}

beforeEach(async () => {
  localStorage.clear()
  world = {}
  activityGate = null
  activityReads = 0; activityInFlight = 0; activityMaxInFlight = 0
  useStore.setState({ ...initial, railSeen: readBack(), projects: [], session: null, runs: [], tree: [], threads: {}, sessionActivity: null } as never)
  globalThis.fetch = (async (url: unknown) => {
    const path = String(url)
    if (path === '/api/projects') return json(projectList())
    if (path === '/api/session-activity') {
      activityReads += 1
      activityInFlight += 1
      activityMaxInFlight = Math.max(activityMaxInFlight, activityInFlight)
      try {
        if (activityGate) await activityGate
        return json({ sessions: Object.fromEntries(SESSIONS.map((s) => [s.id, { live: of(s.id).live, director: null, ended: of(s.id).ended }])) })
      } finally { activityInFlight -= 1 }
    }
    return new Response(JSON.stringify({ detail: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  root = createRoot(container)
  await act(async () => root.render(createElement(Sidebar)))
})
afterEach(async () => { await act(async () => root.unmount()); await flush(); await setVisible(true) })

test('first load: old history never turns green; a background run is blue at its row end, with no words beside it', async () => {
  world = { s_old: w({ ended: 3, lastDone: { at: T0 } }), s_bg: w({ live: [running()], ended: 1, lastDone: { at: T0 } }), s_queue: w({ live: [running('q', 'queued')] }) }
  await poll()
  assert.equal(dotOf('s_old'), null)
  assert.equal(dotOf('s_bg'), 'running')
  assert.equal(dotOf('s_queue'), null) // in line: nothing of it runs yet
  const button = container.querySelector('[data-testid="session-s_bg"]')!
  assert.equal(button.textContent, 'Background work') // the dot adds no text
  const dot = container.querySelector('[data-testid="rail-dot-s_bg"]')!
  assert.equal(dot.getAttribute('role'), 'img')
  assert.equal(dot.getAttribute('aria-label'), 'Running')
  assert.equal(dot.className, 'rail-dot rail-dot-running')
})

test('a background session ends: green until the person opens it, then gone — and still gone after a restart', async () => {
  world = { s_bg: w({ live: [running('a'), running('b')] }) }
  await poll()
  assert.equal(dotOf('s_bg'), 'running')
  // one of two agents ended: still running
  world = { s_bg: w({ live: [running('b')], ended: 1, lastDone: { at: T0 } }) }
  await poll()
  assert.equal(dotOf('s_bg'), 'running')
  world = { s_bg: w({ ended: 2, lastDone: { at: T1 } }) }
  await poll()
  assert.equal(dotOf('s_bg'), 'unread')
  // the person opens it: seen at once, the green goes and stays gone once they leave
  await openSession('s_bg')
  assert.equal(dotOf('s_bg'), null)
  await leave()
  assert.equal(dotOf('s_bg'), null)
  // a restart: a new page reads the marks back; nothing seen turns green again
  await act(async () => root.unmount())
  useStore.setState({ ...initial, railSeen: readBack(), projects: [], sessionActivity: null } as never)
  root = createRoot(container)
  await act(async () => root.render(createElement(Sidebar)))
  await poll()
  assert.equal(dotOf('s_bg'), null)
  // an end after the restart, while the app was away from it: green
  world = { s_bg: w({ ended: 3, lastDone: { at: '2026-10-18T11:00:00.000Z' } }) }
  await poll()
  assert.equal(dotOf('s_bg'), 'unread')
})

test('regression: a run that fails, is stopped elsewhere or is interrupted in the background is an end — green, with no other colour', async () => {
  world = { s_fail: w({ live: [running('f')], ended: 1, lastDone: { at: T0 } }) }
  await poll()
  assert.equal(dotOf('s_fail'), 'running')
  // it failed: its latest done end is still the old one; it ended all the same
  world = { s_fail: w({ ended: 2, lastDone: { at: T0 } }) }
  await poll()
  assert.equal(dotOf('s_fail'), 'unread')
  assert.equal(container.querySelector('[data-testid="rail-dot-s_fail"]')!.className, 'rail-dot rail-dot-unread')
})

test('regression: two ends in the same millisecond — the first seen while reading, the second after leaving — the second is unread', async () => {
  world = { s_bg: w({ ended: 0 }) }
  await poll()
  // the person reads the session while its first run ends at T1
  await openSession('s_bg')
  world = { s_bg: w({ ended: 1, lastDone: { at: T1 } }) }
  await poll()
  await leave()
  assert.equal(dotOf('s_bg'), null)
  // a second run of it ends in the very same millisecond, after they left: unread
  world = { s_bg: w({ ended: 2, lastDone: { at: T1 } }) }
  await poll()
  assert.equal(dotOf('s_bg'), 'unread')
})

test('a later failure never hides an earlier unseen end', async () => {
  world = { s_bg: w({ ended: 1, lastDone: { at: T0 } }) }
  await poll()
  world = { s_bg: w({ ended: 2, lastDone: { at: T1 } }) }
  await poll()
  assert.equal(dotOf('s_bg'), 'unread')
  world = { s_bg: w({ ended: 3, lastDone: { at: T1 } }) }
  await poll()
  assert.equal(dotOf('s_bg'), 'unread')
})

test('the open session: blue from its own records at once; an end (a stop the person made) counted while they are still there never turns green', async () => {
  world = { s_bg: w({ ended: 1, lastDone: { at: T0 } }) }
  await poll()
  const live = { id: 'run_live', session_id: 's_bg', status: 'running', spawned_by: 'human', model: 'm', created_at: T1, finished_at: null, receipt: {}, parent_run_id: null }
  await openSession('s_bg', [live])
  // the summary does not know it yet: the page's records say it runs
  assert.equal(dotOf('s_bg'), 'running')
  // the person stops it while reading; the read the stream's end asks for lands while they are still there
  world = { s_bg: w({ ended: 2, lastDone: { at: T0 } }) }
  await act(async () => { useStore.setState({ runs: [{ ...live, status: 'cancelled', finished_at: T1 }] as never }) })
  await poll()
  await leave()
  assert.equal(dotOf('s_bg'), null)
  await poll()
  assert.equal(dotOf('s_bg'), null)
})

/** A read of the activity held until `open()`: what the page asked lands later. */
function holdReads() {
  let open!: () => void
  activityGate = new Promise<void>((r) => { open = r })
  return () => { activityGate = null; open() }
}

test('regression: a read asked while the person was in A lands after they went to B — an end of A it counts is unread', async () => {
  world = { s_bg: w({ ended: 0 }), s_old: w({ ended: 0 }) }
  await poll()
  assert.equal(readBack().marks.s_bg, 0)
  await openSession('s_bg')
  const open = holdReads()
  let read!: Promise<void>
  await act(async () => { read = useStore.getState().loadSessionActivity() })
  // the person goes to B; A ends after they left; the read asked in A lands now
  await openSession('s_old')
  world = { s_bg: w({ ended: 1 }), s_old: w({ ended: 0 }) }
  open()
  await act(async () => { await read })
  await flush()
  assert.equal(readBack().marks.s_bg, 0)
  assert.equal(dotOf('s_bg'), 'unread')
})

test('regression: a read queued behind one in flight, the person having left A and B since — only the session in view as it lands is seen', async () => {
  world = { s_bg: w({ ended: 0 }), s_old: w({ ended: 0 }), s_fail: w({ ended: 0 }) }
  await poll()
  await openSession('s_bg')
  const open = holdReads()
  let read!: Promise<void>
  await act(async () => {
    read = useStore.getState().loadSessionActivity()   // asked in A
  })
  await openSession('s_old')
  await act(async () => { void useStore.getState().loadSessionActivity() })   // queued, asked in B
  await openSession('s_fail')
  // A and B both end after the person left them; the queued read lands with the person in C
  world = { s_bg: w({ ended: 1 }), s_old: w({ ended: 1 }), s_fail: w({ ended: 1 }) }
  open()
  await act(async () => { await read })
  await flush()
  assert.equal(activityReads >= 2, true)
  assert.equal(dotOf('s_bg'), 'unread')
  assert.equal(dotOf('s_old'), 'unread')
  assert.equal(readBack().marks.s_fail, 1)
  assert.equal(dotOf('s_fail'), null)
})

test('regression: a read asked in view lands while the window is hidden — it sees nothing; back in view the open session is seen', async () => {
  world = { s_bg: w({ ended: 0 }) }
  await poll()
  await openSession('s_bg')
  const open = holdReads()
  let read!: Promise<void>
  await act(async () => { read = useStore.getState().loadSessionActivity() })
  await setVisible(false)
  world = { s_bg: w({ ended: 1 }) }
  open()
  await act(async () => { await read })
  await flush()
  assert.equal(readBack().marks.s_bg, 0)
  assert.equal(dotOf('s_bg'), 'unread')
  await setVisible(true)
  await flush()
  assert.equal(readBack().marks.s_bg, 1)
  assert.equal(dotOf('s_bg'), null)
})

test('a green dot clicked goes at once, from the summary the page holds (no read needed)', async () => {
  world = { s_bg: w({ ended: 0 }) }
  await poll()
  world = { s_bg: w({ ended: 2 }) }
  await poll()
  assert.equal(dotOf('s_bg'), 'unread')
  const before = activityReads
  await openSession('s_bg')
  assert.equal(dotOf('s_bg'), null)
  assert.equal(readBack().marks.s_bg, 2)
  assert.equal(activityReads, before)
})

test('the open session in a hidden window is not seen: its end turns green; back in view it is seen', async () => {
  world = { s_bg: w({ ended: 1 }) }
  await poll()
  await setVisible(false)
  await openSession('s_bg')
  world = { s_bg: w({ ended: 2 }) }
  await poll()
  assert.equal(readBack().marks.s_bg, 1)
  assert.equal(dotOf('s_bg'), 'unread')
  await setVisible(true)
  await flush()
  assert.equal(readBack().marks.s_bg, 2)
  assert.equal(dotOf('s_bg'), null)
})

test('the activity is read one at a time: reads asked meanwhile wait and become one more read', async () => {
  let open!: () => void
  activityGate = new Promise<void>((r) => { open = r })
  let first!: Promise<void>
  await act(async () => {
    first = useStore.getState().loadSessionActivity()
    void useStore.getState().loadSessionActivity()
    void useStore.getState().loadSessionActivity()
  })
  assert.equal(activityReads, 1)
  open()
  await act(async () => { await first })
  assert.equal(activityMaxInFlight, 1)
  assert.equal(activityReads, 2)
})
