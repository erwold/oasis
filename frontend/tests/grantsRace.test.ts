/** A change of a session's grants (Permissions: Network → Turn on) belongs to the session it was asked for and to
 *  that opening of it: an answer that comes back after the page opened another session — or left and came back —
 *  never replaces the session shown, and of two changes of the same session the later one's answer is the one that
 *  stays, whatever order the answers arrive in. Through the store's HTTP traffic (a stubbed fetch) and its real
 *  openSession / send. */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
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

// storage: in memory, cleared before each test (never the machine's); the page's globals the store reads
const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) }, clear: () => stored.clear() } })
Object.assign(globalThis, { window: globalThis, __OASIS_CODE_BUILD__: 'test' })

// the harness: every request the page makes, answered by the test's routes (anything else: 404)
interface Call { method: string; path: string; body: unknown }
type Answer = { status: number; body: unknown }
type Reply = Answer | Promise<Answer>
let calls: Call[] = []
let routes: (call: Call) => Reply | undefined = () => undefined
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = String(input)
  const call: Call = { method: init?.method ?? 'GET', path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }
  calls.push(call)
  const reply = (await routes(call)) ?? { status: 404, body: { detail: 'not found' } }
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path)
const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)) }

const storeModule = await import('../src/state/store.ts')
const { useStore } = storeModule
const initial = { ...useStore.getState() }

type Grants = { workspace_write: boolean; run_commands: boolean; attached_write: boolean; network: boolean; network_until: null; network_reason: null }
const grants = (over: Partial<Grants> = {}): Grants => ({ workspace_write: true, run_commands: true, attached_write: true, network: false, network_until: null, network_reason: null, ...over })
const run = (id: string) => ({ id, status: 'completed', model: 'scripted:a', parent_run_id: null })
/** a session as the harness answers it: its own runs, its grants */
const session = (id: string, g: Grants = grants(), runs: string[] = []): SessionDetail => ({
  id, project_id: 'p', model: 'scripted:a', title: id, workspace: null, workspace_id: null, runs: runs.map(run), director: null, interactions: [], relays: [], director_notes: [], grants: g,
} as unknown as SessionDetail)

/** answers each held, released by the test in the order it chooses */
function held() {
  const waiting: ((answer: Answer) => void)[] = []
  return {
    reply: (): Promise<Answer> => new Promise((r) => { waiting.push(r) }),
    release: (i: number, answer: Answer) => waiting[i]!(answer),
    get count() { return waiting.length },
  }
}

/** the session's own reads the harness answers while it is open: its detail, its runs' transcripts, its chat */
function serve(s: SessionDetail, before = routes) {
  routes = (call) => {
    if (call.method === 'GET' && (call.path === `/api/sessions/${s.id}` || call.path === `/api/sessions/${s.id}?transcripts=1`)) return { status: 200, body: s }
    if (call.method === 'GET' && /^\/api\/runs\/[^/]+\/transcript$/.test(call.path)) return { status: 200, body: { entries: [], steers: [] } }
    if (call.method === 'POST' && call.path === `/api/sessions/${s.id}/chat`) return { status: 200, body: { id: `run_${s.id}_next`, status: 'running' } }
    return before(call)
  }
}
async function open(s: SessionDetail) {
  serve(s)
  await useStore.getState().openSession(s.id)
  await tick()
}

beforeEach(() => {
  stored.clear()
  calls = []
  routes = () => undefined
  storeModule.resetAccessEpoch()
  useStore.setState({ ...initial, session: null, images: [], draft: '', composers: {}, projects: [{ id: 'p', name: 'P', kind: 'direct', source_path: '/w' } as never], target: { kind: 'project', projectId: 'p', name: 'P', path: '/w' }, composerTarget: 'agent' })
  // what opening a session reads beside its detail: not this test's
  for (const key of ['loadTree', 'loadCollab', 'refreshGate', 'loadAccess', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'loadDirector', 'syncSession'] as const) useStore.setState({ [key]: async () => {} })
  useStore.setState({ watchRun: () => {} })
})

test('A\'s grants answered after the page opened B: B stays the session, its runs and grants are B\'s, and a send goes to B', async () => {
  const a = session('A', grants(), ['run_a']), b = session('B', grants({ attached_write: false }), ['run_b'])
  const puts = held()
  await open(a)
  serve(b, ((prev) => (call: Call) => (call.method === 'PUT' && call.path === '/api/sessions/A/grants' ? puts.reply() : prev(call)))(routes))
  const changing = useStore.getState().setGrants({ network: true })
  await tick()
  assert.equal(sent('PUT', '/api/sessions/A/grants').length, 1, 'A\'s change was asked')
  await useStore.getState().openSession('B')
  await tick()
  assert.equal(useStore.getState().session?.id, 'B')
  puts.release(0, { status: 200, body: session('A', grants({ network: true }), ['run_a']) })
  await changing
  await tick()
  const now = useStore.getState()
  assert.equal(now.session?.id, 'B', `the session shown became ${now.session?.id}`)
  assert.deepEqual(now.session?.grants, b.grants, 'B\'s grants, never A\'s')
  assert.deepEqual(now.session?.runs.map((r) => r.id), ['run_b'])
  assert.deepEqual(now.runs.map((r) => r.id), ['run_b'])
  // what the person writes next goes to B
  calls = []
  useStore.setState({ draft: 'go on' })
  await useStore.getState().send('go on')
  assert.equal(sent('POST', '/api/sessions/B/chat').length, 1, 'the message went to B')
  assert.equal(sent('POST', '/api/sessions/A/chat').length, 0, 'nothing went to A')
})

test('A left and opened again: the change asked before leaving, answered late, never replaces what the new opening read', async () => {
  const puts = held()
  const first = session('A', grants())
  await open(first)
  routes = ((prev) => (call: Call) => (call.method === 'PUT' && call.path === '/api/sessions/A/grants' ? puts.reply() : prev(call)))(routes)
  const changing = useStore.getState().setGrants({ network: true })
  await tick()
  await open(session('B'))
  // meanwhile A changed elsewhere (the director turned the attached folder off): the second opening reads that
  const reread = session('A', grants({ network: true, attached_write: false }))
  await open(reread)
  puts.release(0, { status: 200, body: session('A', grants({ network: true })) })
  await changing
  await tick()
  assert.equal(useStore.getState().session?.id, 'A')
  assert.deepEqual(useStore.getState().session?.grants, reread.grants, 'the late answer of the first opening is not taken')
})

test('two changes of the same session: the later one stays whatever order the answers come in; each answer in order shows', async () => {
  // answered out of order: the second first, then the first
  {
    const puts = held()
    await open(session('S'))
    routes = ((prev) => (call: Call) => (call.method === 'PUT' && call.path === '/api/sessions/S/grants' ? puts.reply() : prev(call)))(routes)
    const on = useStore.getState().setGrants({ network: true })
    const off = useStore.getState().setGrants({ network: false, attached_write: false })
    await tick()
    assert.equal(puts.count, 2)
    puts.release(1, { status: 200, body: session('S', grants({ network: false, attached_write: false })) })
    await off
    assert.deepEqual(useStore.getState().session?.grants, grants({ network: false, attached_write: false }))
    puts.release(0, { status: 200, body: session('S', grants({ network: true })) })
    await on
    await tick()
    assert.deepEqual(useStore.getState().session?.grants, grants({ network: false, attached_write: false }), 'the earlier answer, late, does not undo the later change')
  }
  // answered in order: each shows as it comes, the last one stays
  {
    const puts = held()
    await open(session('T'))
    routes = ((prev) => (call: Call) => (call.method === 'PUT' && call.path === '/api/sessions/T/grants' ? puts.reply() : prev(call)))(routes)
    const on = useStore.getState().setGrants({ network: true })
    const off = useStore.getState().setGrants({ attached_write: false })
    await tick()
    puts.release(0, { status: 200, body: session('T', grants({ network: true })) })
    await on
    assert.deepEqual(useStore.getState().session?.grants, grants({ network: true }), 'the first answer shows while the second is on its way')
    puts.release(1, { status: 200, body: session('T', grants({ network: true, attached_write: false })) })
    await off
    assert.deepEqual(useStore.getState().session?.grants, grants({ network: true, attached_write: false }))
  }
})

test('a change of the session shown is taken, and its refusal is said; a refusal of a session left says nothing to the one shown', async () => {
  await open(session('C'))
  routes = ((prev) => (call: Call) => (call.method === 'PUT' && call.path === '/api/sessions/C/grants' ? { status: 200, body: session('C', grants({ network: true })) } : prev(call)))(routes)
  await useStore.getState().setGrants({ network: true })
  assert.deepEqual(useStore.getState().session?.grants, grants({ network: true }))
  routes = ((prev) => (call: Call) => (call.method === 'PUT' && call.path === '/api/sessions/C/grants' ? { status: 409, body: { detail: 'refused' } } : prev(call)))(routes)
  await assert.rejects(useStore.getState().setGrants({ network: false }), 'the session shown: its refusal reaches the caller (Permissions says it)')
  assert.deepEqual(useStore.getState().session?.grants, grants({ network: true }))
  // asked for C, refused once D is open: D is untouched and the caller hears nothing
  const puts = held()
  routes = ((prev) => (call: Call) => (call.method === 'PUT' && call.path === '/api/sessions/C/grants' ? puts.reply() : prev(call)))(routes)
  const changing = useStore.getState().setGrants({ network: false })
  await tick()
  const d = session('D', grants({ attached_write: false }))
  await open(d)
  puts.release(0, { status: 409, body: { detail: 'refused' } })
  await changing
  assert.equal(useStore.getState().session?.id, 'D')
  assert.deepEqual(useStore.getState().session?.grants, d.grants)
})
