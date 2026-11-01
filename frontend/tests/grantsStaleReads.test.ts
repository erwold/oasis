/** A read of the open session that left before the page changed its grants or mode (Permissions: Turn on, Switch to
 *  Auto), or that lands while such a change is on its way, never puts the grants or the control back as they were:
 *  the session's sync (when a run moved meanwhile), the evidence refresh, the Permissions panel's mode read (the panel
 *  shown again) and the gate's control read. A change asked in one opening of a session never lands on a later one
 *  (A → B → A). Everything else such a read brings is taken (a run that ended, the workspace), a rename made meanwhile
 *  keeps its title, a change of the session shown is taken and its refusal said. Through the store's HTTP traffic (a
 *  stubbed fetch), its real entry points and the Permissions panel as React renders it in a DOM. */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import type { SessionDetail } from '../src/api/types.ts'

// The application is bundled by Vite: for Node, its extensionless imports resolve to .ts / .tsx, its components are
// compiled with TypeScript, and an asset import (CSS, an image) is its URL.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) {
        const candidate = new URL(`${specifier}${ext}`, context.parentURL)
        if (existsSync(candidate)) return next(candidate.href, context)
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) {
      const file = fileURLToPath(url)
      const out = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
      return { format: 'module', source: out.outputText, shortCircuit: true }
    }
    return next(url, context)
  },
})

// a DOM of its own (never the machine's storage); the page's globals the store and the panel read
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://ui.invalid/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, __OASIS_CODE_BUILD__: 'test' })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })

// the harness: every request the page makes, answered by the test's routes (anything else: 404)
interface Call { method: string; path: string; body: unknown }
type Answer = { status?: number; body: unknown }
type Reply = Answer | Promise<Answer>
let calls: Call[] = []
let routes: (call: Call) => Reply | undefined = () => undefined
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call: Call = { method: init?.method ?? 'GET', path: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }
  calls.push(call)
  // These grant races also exercise the older backend's unbundled reply. Route only the known opening flag
  // to the same detail fixture; retain the actual URL in calls so sync/refresh request counts stay exact.
  const routeCall = call.method === 'GET' && /^\/api\/sessions\/[^/?]+\?transcripts=1$/.test(call.path)
    ? { ...call, path: call.path.slice(0, -'?transcripts=1'.length) } : call
  const reply = (await routes(routeCall)) ?? { status: 404, body: { detail: 'not found' } }
  return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length
const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)) }

const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useStore } = await import('../src/state/store.ts')
const { Permissions } = await import('../src/components/Permissions.tsx')
// the store's own actions, kept before each test stubs the reads opening a session makes beside its detail
const real = { ...useStore.getState() }

const grants = (network = false) => ({ workspace_write: true, run_commands: true, attached_write: true, network, network_until: null, network_reason: null })
const run = (status: string) => ({ id: 'r', status, model: 'scripted:a', parent_run_id: null })
const session = (id: string, network = false, extra: Record<string, unknown> = {}): SessionDetail => ({
  id, project_id: 'p', model: 'scripted:a', title: id, workspace: null, workspace_id: null, runs: [], director: null, interactions: [], relays: [], director_notes: [], grants: grants(network), ...extra,
} as unknown as SessionDetail)
const auto = { desired_state: 'run', gate_effects: [] }
const approve = { desired_state: 'pause', gate_effects: ['workspace_write', 'isolated_code_execution', 'state_change', 'network'] }
/** one answer, held until the test releases it */
function held() {
  let release!: (answer: Answer) => void
  const promise = new Promise<Answer>((r) => { release = r })
  return { promise, release }
}
const now = () => useStore.getState()

function reset(s: SessionDetail, control: unknown = auto) {
  real.closeSession()
  localStorage.clear()
  calls = []
  routes = () => undefined
  useStore.setState({ ...real, session: s, runs: s.runs, notes: [], threads: {}, control: control as never, toast: null, projects: [{ id: 'p', name: 'P', kind: 'direct', source_path: '/w' } as never], target: { kind: 'project', projectId: 'p', name: 'P', path: '/w' }, composerTarget: 'agent' })
  for (const key of ['loadTree', 'loadCollab', 'refreshGate', 'loadAccess', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'loadDirector', 'syncSession'] as const) useStore.setState({ [key]: async () => {} })
  useStore.setState({ watchRun: () => {} })
}

const container = dom.window.document.getElementById('root')!
let root: ReturnType<typeof createRoot> | null = null
const mount = async () => { root = createRoot(container); await act(async () => { root!.render(createElement(Permissions)); await tick() }) }
const unmount = async () => { if (root) await act(async () => { root!.unmount(); await tick() }); root = null }
const button = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null
const click = async (id: string) => { const b = button(id); assert.ok(b, `${id} is shown`); assert.equal(b!.disabled, false, `${id} is enabled`); await act(async () => { b!.click(); await tick() }) }

beforeEach(() => reset(session('A')))
afterEach(async () => { await unmount() })

test('the sync: a read that left before Turn on and brings a run that ended takes the run, never the old grants; one that left after takes the grants as they are', async () => {
  // grants only (nothing else moved): the sync takes nothing of the session, as before
  for (const runEnded of [false, true]) {
    const before = session('A', false, runEnded ? { runs: [run('running')] } : {})
    reset(before)
    const read = held()
    routes = (c) => c.method === 'GET' && c.path === '/api/sessions/A' ? read.promise
      : c.method === 'PUT' && c.path === '/api/sessions/A/grants' ? { body: session('A', true, runEnded ? { runs: [run('completed')] } : {}) }
      : c.method === 'GET' && c.path === '/api/runs/r/transcript' ? { body: { entries: [], steers: [] } } : undefined
    const syncing = real.syncSession()
    await tick()
    assert.equal(sent('GET', '/api/sessions/A'), 1, 'the sync left first')
    await now().setGrants({ network: true })
    assert.equal(now().session?.grants.network, true)
    read.release({ body: session('A', false, runEnded ? { runs: [run('completed')] } : {}) })
    await syncing
    await tick()
    assert.equal(now().session?.grants.network, true, `the network stays on (run ended: ${runEnded})`)
    if (runEnded) {
      assert.equal(now().session?.runs[0]?.status, 'completed', 'the run that ended is taken')
      assert.equal(now().runs[0]?.status, 'completed')
    }
  }
  // a sync that leaves once the change is in reads the session as it is: a network turned off elsewhere is taken
  reset(session('A', true, { runs: [run('running')] }))
  routes = (c) => c.method === 'GET' && c.path === '/api/sessions/A' ? { body: session('A', false, { runs: [run('completed')] }) } : undefined
  await real.syncSession()
  await tick()
  assert.equal(now().session?.grants.network, false, 'a change made elsewhere comes with the next sync')
})

test('the evidence refresh: a read that left before Turn on takes the workspace and the diff, never the old grants; a rename meanwhile keeps its title', async () => {
  const workspace = { id: 'w', path: '/w', kind: 'direct' }
  reset(session('A', false, { workspace, workspace_id: 'w' }))
  const read = held()
  routes = (c) => c.method === 'GET' && c.path === '/api/sessions/A' ? read.promise
    : c.method === 'GET' && c.path === '/api/workspaces/w' ? { body: { ...workspace, marker: 'fresh' } }
    : c.method === 'GET' && c.path.startsWith('/api/workspaces/w/diff') ? { body: { files: [] } }
    : c.method === 'PUT' && c.path === '/api/sessions/A/grants' ? { body: session('A', true, { workspace, workspace_id: 'w' }) }
    : c.method === 'PUT' && c.path === '/api/sessions/A' ? { body: session('A', true, { workspace, workspace_id: 'w', title: 'Renamed' }) } : undefined
  const refreshing = real.refreshEvidence()
  await tick()
  assert.equal(sent('GET', '/api/sessions/A'), 1, 'the refresh left first')
  await now().setGrants({ network: true })
  await now().renameSession('A', 'Renamed')
  assert.equal(now().session?.grants.network, true)
  read.release({ body: session('A', false, { workspace, workspace_id: 'w', title: 'A' }) })
  await refreshing
  await tick()
  assert.equal(now().session?.grants.network, true, 'the network stays on')
  assert.equal(now().session?.title, 'Renamed', 'the rename stands')
  assert.equal((now().workspace as unknown as { marker?: string })?.marker, 'fresh', 'the workspace read is taken')
})

test('the Permissions panel shown again while Turn on is on its way: its mode read never turns the network back off', async () => {
  const old = session('A', false)
  reset(old)
  const put = held(), modeRead = held()
  let again = false
  routes = (c) => c.method === 'GET' && c.path === '/api/sessions/A/mode' ? (again ? modeRead.promise : { body: { session: old, control: auto } })
    : c.method === 'PUT' && c.path === '/api/sessions/A/grants' ? put.promise : undefined
  await mount()
  await click('grant-network')
  assert.equal(sent('PUT', '/api/sessions/A/grants'), 1)
  await unmount()
  again = true
  await mount()
  assert.equal(sent('GET', '/api/sessions/A/mode'), 2, 'the panel read the mode again')
  await act(async () => { put.release({ body: session('A', true) }); await tick() })
  assert.equal(now().session?.grants.network, true)
  await act(async () => { modeRead.release({ body: { session: old, control: auto } }); await tick() })
  assert.equal(now().session?.grants.network, true, 'the network stays on')
  assert.equal(button('grant-network'), null, 'the panel offers no Turn on')
})

test('Switch to Auto asked in A, answered after A → B → A: the reopened A keeps its grants, title and control', async () => {
  const a = session('A', true), b = session('B', false), reopened = session('A', false, { title: 'A reopened' })
  reset(a, approve)
  const put = held()
  let second = false
  routes = (c) => {
    if (c.method === 'PUT' && c.path === '/api/sessions/A/mode') return put.promise
    if (c.method === 'GET' && c.path === '/api/sessions/A/mode') return { body: { session: second ? reopened : a, control: approve } }
    if (c.method === 'GET' && c.path === '/api/sessions/B/mode') return { body: { session: b, control: auto } }
    if (c.method === 'GET' && c.path === '/api/sessions/A') return { body: second ? reopened : a }
    if (c.method === 'GET' && c.path === '/api/sessions/B') return { body: b }
    return undefined
  }
  await mount()
  await click('permissions-auto')
  assert.equal(sent('PUT', '/api/sessions/A/mode'), 1)
  await act(async () => { await now().openSession('B'); await tick() })
  second = true
  await act(async () => { await now().openSession('A'); await tick() })
  const before = { network: now().session?.grants.network, title: now().session?.title, control: now().control?.desired_state }
  assert.deepEqual(before, { network: false, title: 'A reopened', control: 'pause' })
  await act(async () => { put.release({ body: { session: a, control: auto } }); await tick() })
  assert.deepEqual({ network: now().session?.grants.network, title: now().session?.title, control: now().control?.desired_state }, before, 'the late answer of the first opening is not taken')
})

test('the Permissions panel\'s mode read of an earlier opening (A → B → A) is not taken; the current one is', async () => {
  const first = session('A', true), b = session('B', false), second = session('A', false, { title: 'A current' })
  reset(first)
  const oldRead = held()
  let seen = 0, reopened = false
  routes = (c) => {
    if (c.method === 'GET' && c.path === '/api/sessions/A/mode') return ++seen === 1 ? oldRead.promise : { body: { session: second, control: auto } }
    if (c.method === 'GET' && c.path === '/api/sessions/B/mode') return { body: { session: b, control: auto } }
    if (c.method === 'GET' && c.path === '/api/sessions/A') return { body: reopened ? second : first }
    if (c.method === 'GET' && c.path === '/api/sessions/B') return { body: b }
    return undefined
  }
  await mount()
  await act(async () => { await now().openSession('B'); await tick() })
  reopened = true
  await act(async () => { await now().openSession('A'); await tick() })
  await act(async () => { oldRead.release({ body: { session: first, control: approve } }); await tick() })
  assert.equal(now().session?.title, 'A current')
  assert.equal(now().session?.grants.network, false)
  assert.equal(now().control?.desired_state, 'run')
})

test('Switch to Auto in the session shown is taken (grants and control); a refusal is said; a gate read that left before it keeps its control', async () => {
  reset(session('A', false), approve)
  const gateRead = held()
  routes = (c) => {
    if (c.method === 'GET' && c.path === '/api/sessions/A/mode') return { body: { session: session('A', false), control: approve } }
    if (c.method === 'PUT' && c.path === '/api/sessions/A/mode') return { body: { session: session('A', true), control: auto } }
    if (c.method === 'GET' && c.path === '/api/sessions/A/agent-control') return gateRead.promise
    if (c.method === 'GET' && c.path === '/api/sessions/A/action-proposals') return { body: { proposals: [{ id: 'p1' }] } }
    return undefined
  }
  await mount()
  assert.equal(now().control?.desired_state, 'pause')
  const gating = real.refreshGate()
  await tick()
  await click('permissions-auto')
  assert.equal(now().control?.desired_state, 'run', 'the mode change is taken')
  assert.equal(now().session?.grants.network, true)
  await act(async () => { gateRead.release({ body: { control: approve, effect_tags: [], gateable_tools: [] } }); await gating; await tick() })
  assert.equal(now().control?.desired_state, 'run', 'the gate read that left before the change keeps its control')
  assert.equal(now().proposals.length, 1, 'the proposals it read are taken')
  // a gate read that leaves after the change takes the control as it is
  routes = ((prev) => (c: Call) => c.method === 'GET' && c.path === '/api/sessions/A/agent-control' ? { body: { control: approve, effect_tags: [], gateable_tools: [] } } : prev(c))(routes)
  await real.refreshGate()
  assert.equal(now().control?.desired_state, 'pause', 'a pause made elsewhere comes with the next read')
  // refused: said in a toast, nothing changed
  await unmount()
  reset(session('A', false), approve)
  routes = (c) => c.method === 'GET' && c.path === '/api/sessions/A/mode' ? { body: { session: session('A', false), control: approve } }
    : c.method === 'PUT' && c.path === '/api/sessions/A/mode' ? { status: 409, body: { detail: 'Stop the active runs before changing mode.' } } : undefined
  await mount()
  await click('permissions-auto')
  assert.match(String(now().toast), /Stop the active runs before changing mode/)
  assert.equal(now().control?.desired_state, 'pause')
})

test('the sync reading a new run\'s transcript while Turn on, Switch to Auto and a rename are made: the run is taken, the change and the title stand', async () => {
  reset(session('A', false), approve)
  const transcript = held()
  routes = (c) => {
    if (c.method === 'GET' && c.path === '/api/sessions/A') return { body: session('A', false, { runs: [{ ...run('completed'), id: 'r2' }] }) }
    if (c.method === 'GET' && c.path === '/api/runs/r2/transcript') return transcript.promise
    if (c.method === 'PUT' && c.path === '/api/sessions/A/grants') return { body: session('A', true) }
    if (c.method === 'PUT' && c.path === '/api/sessions/A/mode') return { body: { session: session('A', true), control: auto } }
    if (c.method === 'PUT' && c.path === '/api/sessions/A') return { body: session('A', true, { title: 'Renamed' }) }
    return undefined
  }
  const syncing = real.syncSession()
  await tick()
  assert.equal(sent('GET', '/api/runs/r2/transcript'), 1, 'the sync is reading the new run\'s transcript')
  // the panel's own mode read (as it stands), then Switch to Auto clicked, the network turned on and the session renamed
  routes = ((prev) => (c: Call) => c.method === 'GET' && c.path === '/api/sessions/A/mode' ? { body: { session: session('A', false), control: approve } } : prev(c))(routes)
  await mount()
  await click('permissions-auto')
  assert.equal(now().control?.desired_state, 'run')
  await now().setGrants({ network: true })
  await now().renameSession('A', 'Renamed')
  transcript.release({ body: { entries: [], steers: [] } })
  await syncing
  await tick()
  assert.deepEqual(now().runs.map((r) => r.id), ['r2'], 'the new run is taken')
  assert.deepEqual(now().session?.runs.map((r) => r.id), ['r2'])
  assert.equal(now().session?.grants.network, true, 'the network stays on')
  assert.equal(now().session?.title, 'Renamed', 'the rename stands')
  assert.equal(now().control?.desired_state, 'run', 'the mode change stands')
})

test('a sync that left in A\'s first opening, answered after A → B → A, takes nothing of the reopened A', async () => {
  const first = session('A', true, { runs: [run('running')] })
  const reopened = session('A', false, { title: 'A reopened', runs: [run('completed')] })
  reset(first)
  const syncRead = held()
  let second = false
  routes = (c) => {
    if (c.method === 'GET' && c.path === '/api/sessions/A') return second ? { body: reopened } : syncRead.promise
    if (c.method === 'GET' && c.path === '/api/sessions/B') return { body: session('B') }
    if (c.method === 'GET' && /^\/api\/runs\/[^/]+\/transcript$/.test(c.path)) return { body: { entries: [], steers: [] } }
    return undefined
  }
  const syncing = real.syncSession()
  await tick()
  await now().openSession('B')
  second = true
  await now().openSession('A')
  await tick()
  assert.equal(now().session?.title, 'A reopened')
  // the first opening's answer: another title, the network on, the run still running
  syncRead.release({ body: { ...first, title: 'A first', runs: [{ ...run('running'), id: 'r_old' }] } })
  await syncing
  await tick()
  assert.equal(now().session?.title, 'A reopened', 'the title the reopening read stands')
  assert.equal(now().session?.grants.network, false, 'the grants the reopening read stand')
  assert.deepEqual(now().runs.map((r) => r.id), ['r'], 'no run of the old answer joins')
  assert.equal(now().runs[0]?.status, 'completed')
})

test('an evidence refresh that left in A\'s first opening, answered after A → B → A, never shows on the reopened A (the reopening\'s own refresh still on its way)', async () => {
  const workspace = { id: 'w', path: '/w', kind: 'direct' }
  const first = session('A', true, { workspace, workspace_id: 'w' })
  const reopened = session('A', false, { workspace, workspace_id: 'w', title: 'A reopened' })
  reset(first)
  const oldRead = held(), newRefresh = held()
  let second = false, newRefreshRequested = false, reopeningDone = false
  routes = (c) => {
    // Opening already reads A's detail. Hold the trailing refresh's workspace response
    // so the old answer arrives before the new refresh completes.
    if (c.method === 'GET' && c.path === '/api/sessions/A') return second ? { body: reopened } : oldRead.promise
    if (c.method === 'GET' && c.path === '/api/sessions/B') return { body: session('B') }
    if (c.method === 'GET' && c.path === '/api/workspaces/w') {
      if (second) { newRefreshRequested = true; return newRefresh.promise }
      return { body: { ...workspace, marker: 'first' } }
    }
    if (c.method === 'GET' && c.path.startsWith('/api/workspaces/w/diff')) return { body: { files: [] } }
    return undefined
  }
  const refreshing = real.refreshEvidence()
  await tick()
  await now().openSession('B')
  second = true
  useStore.setState({ refreshEvidence: real.refreshEvidence })
  const reopening = now().openSession('A').then(() => { reopeningDone = true })
  await tick()
  assert.equal(now().session?.title, 'A reopened')
  assert.equal(newRefreshRequested, false, 'the new refresh is coalesced behind the old request')
  assert.equal(reopeningDone, false, 'the reopening still waits for its evidence refresh')
  oldRead.release({ body: { ...first, title: 'A first' } })
  await tick()
  assert.equal(newRefreshRequested, true, 'the trailing evidence request left after the old one settled')
  assert.equal(reopeningDone, false, 'the old answer does not complete the new refresh')
  assert.equal(now().session?.title, 'A reopened', 'the old refresh\'s title never shows')
  assert.equal(now().session?.grants.network, false, 'the old refresh\'s grants never show')
  assert.notEqual((now().workspace as unknown as { marker?: string } | null)?.marker, 'first', 'the old refresh\'s workspace never shows')
  newRefresh.release({ body: { ...workspace, marker: 'reopened' } })
  await Promise.all([refreshing, reopening])
  await tick()
  assert.equal(now().session?.title, 'A reopened')
  assert.equal((now().workspace as unknown as { marker?: string })?.marker, 'reopened', 'the reopening\'s refresh is taken')
})

for (const kind of ['refreshEvidence', 'refreshGate'] as const) {
  const workspace = { id: 'w', path: '/w', kind: 'direct' }
  const heldPath = kind === 'refreshEvidence' ? '/api/sessions/A' : '/api/sessions/A/agent-control'
  /** A's routes: the read this test fails (held, or refused at once), the rest answered */
  const routesOf = (fail: () => Reply, second: () => boolean) => (c: Call): Reply | undefined => {
    if (c.method === 'GET' && c.path === '/api/sessions/B') return { body: session('B', true) }
    if (c.method === 'GET' && c.path === '/api/sessions/A' && second()) return { body: session('A', false, { workspace, workspace_id: 'w', title: 'A reopened' }) }
    if (c.method === 'GET' && c.path === heldPath) return fail()
    if (c.method === 'GET' && c.path === '/api/sessions/A/action-proposals') return { body: { proposals: [] } }
    if (c.method === 'GET' && c.path === '/api/workspaces/w') return { body: workspace }
    if (c.method === 'GET' && c.path.startsWith('/api/workspaces/w/diff')) return { body: { files: [] } }
    return undefined
  }
  const refusal = (what: string): Answer => ({ status: 409, body: { detail: `${what} ${kind} was refused` } })

  test(`${kind}: a failure of the session shown is said; one of A answered after A → B, or after A → B → A, says nothing and leaves the toast shown`, async () => {
    // the session shown: its failure is said
    reset(session('A', false, { workspace, workspace_id: 'w' }))
    routes = routesOf(() => refusal('current A'), () => false)
    await real[kind]()
    await tick()
    assert.match(String(now().toast), new RegExp(`current A ${kind} was refused`), 'the failure of the session shown is said')

    // A → B: A's failure, late, is not said on B
    reset(session('A', false, { workspace, workspace_id: 'w' }))
    let refused = held()
    routes = routesOf(() => refused.promise, () => false)
    let pending = real[kind]()
    await tick()
    assert.equal(sent('GET', heldPath), 1, 'A\'s read left')
    await now().openSession('B')
    await tick()
    assert.equal(now().session?.id, 'B')
    assert.equal(now().toast, null)
    refused.release(refusal('old A'))
    await pending
    await tick()
    assert.equal(now().toast, null, 'A\'s failure is not said on B')

    // A → B → A: the first opening's failure, late, neither shows nor replaces the toast the reopened A shows
    reset(session('A', false, { workspace, workspace_id: 'w' }))
    refused = held()
    let second = false
    routes = routesOf(() => refused.promise, () => second)
    pending = real[kind]()
    await tick()
    await now().openSession('B')
    second = true
    await now().openSession('A')
    await tick()
    assert.equal(now().session?.title, 'A reopened')
    now().showToast('the reopened A\'s own word')
    refused.release(refusal('first-opening A'))
    await pending
    await tick()
    assert.equal(now().toast, 'the reopened A\'s own word', 'the first opening\'s failure does not replace the toast shown')
  })
}
