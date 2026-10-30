/** Where a session's commands run (full | sandbox), beside its mode: the start screen's default (full), an older
 *  session's (sandbox), the one full-access confirmation, a change refused while the session is busy, nothing carried
 *  from one session to another, and the access read again when a run ends — through the store's HTTP traffic (a
 *  stubbed fetch) and the composer as React renders it. */
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

// storage: in memory, cleared before each test (never the machine's); the page's globals the components read
const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) }, clear: () => stored.clear() } })
Object.assign(globalThis, { window: globalThis, __OASIS_CODE_BUILD__: 'test' })

// the harness: every request the page makes, answered by the test's routes (anything else: 404)
interface Call { method: string; path: string; body: unknown }
type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>
let calls: Call[] = []
let routes: (call: Call) => Reply | undefined = () => undefined
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = String(input)
  const call: Call = { method: init?.method ?? 'GET', path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }
  calls.push(call)
  const reply = (await routes(call)) ?? { status: 404, body: { detail: 'not found' } }
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const sent = (method: string, part: string | RegExp) => calls.filter((c) => c.method === method && (typeof part === 'string' ? c.path.includes(part) : part.test(c.path)))
const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)) }

const storeModule = await import('../src/state/store.ts')
const { useStore } = storeModule
const { renderToStaticMarkup } = await import('react-dom/server')
const { createElement } = await import('react')
const { Composer } = await import('../src/components/Composer.tsx')
const initial = { ...useStore.getState() }
// React renders a store on the server from its initial state (useSyncExternalStore's server snapshot): before each
// render that object takes the state as it stands, so the markup is what the page would show now
const asNow = () => { Object.assign(useStore.getInitialState(), useStore.getState()) }

const grants = { workspace_write: true, run_commands: true, attached_write: true, network: true, network_until: null, network_reason: null }
/** a session as the harness answers it; `access` undefined: an older harness's answer, without the field */
const session = (id: string, access?: 'full' | 'sandbox', extra: Record<string, unknown> = {}): SessionDetail => ({
  id, project_id: 'p', model: 'scripted:a', title: id, workspace: null, workspace_id: null, runs: [], director: null, interactions: [], relays: [], director_notes: [], grants,
  ...(access ? { access_mode: access } : {}), ...extra,
} as unknown as SessionDetail)
const accessAnswer = (s: SessionDetail, switchable = true, blocked = { runs: 0, executions: 0, approvals: 0 }) =>
  ({ status: 200, body: { access_mode: (s as { access_mode?: string }).access_mode ?? 'sandbox', switchable, blocked_by: blocked, session: s } })

const composer = (hero = false) => { asNow(); return renderToStaticMarkup(createElement(Composer as (props: { hero?: boolean }) => ReturnType<typeof Composer>, { hero })) }
const chipOf = (html: string) => html.match(/<button[^>]*data-testid="access-chip"[^>]*>/)?.[0] ?? null

beforeEach(() => {
  stored.clear()
  calls = []
  routes = () => undefined
  storeModule.resetAccessEpoch()
  useStore.setState({ ...initial, session: null, images: [], draft: '', composers: {}, projects: [{ id: 'p', name: 'P', kind: 'direct', source_path: '/w' } as never], target: { kind: 'project', projectId: 'p', name: 'P', path: '/w' }, composerTarget: 'agent' })
  // what opening a session reads beside the session and its access: not this test's
  for (const key of ['loadTree', 'loadCollab', 'refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'loadDirector', 'syncSession'] as const) useStore.setState({ [key]: async () => {} })
  useStore.setState({ watchRun: () => {} })
})

/** the harness of a start-screen task: the session it makes (as asked), its first run */
function startRoutes(made: (body: Record<string, unknown>) => SessionDetail) {
  return (call: Call): Reply | undefined => {
    if (call.method === 'POST' && call.path === '/api/projects/p/sessions') return { status: 200, body: made(call.body as Record<string, unknown>) }
    if (call.method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(call.path)) return { status: 200, body: session(call.path.split('/').pop()!, 'full') }
    if (call.method === 'POST' && call.path.endsWith('/chat')) return { status: 200, body: { id: 'run_1', status: 'running' } }
    return undefined
  }
}

async function open(s: SessionDetail, access: (call: Call) => Reply | undefined = () => accessAnswer(s)) {
  const before = routes
  routes = (call) => {
    if (call.method === 'GET' && call.path === `/api/sessions/${s.id}`) return { status: 200, body: s }
    if (call.path === `/api/sessions/${s.id}/access`) return access(call)
    return before(call)
  }
  await useStore.getState().openSession(s.id)
  await tick()
}

test('Full access is the default and takes no room: no chip on the start screen or in a Full session; a new session names no access (the harness makes it Full)', async () => {
  assert.equal(chipOf(composer(true)), null, 'the start screen\'s composer has no access chip')
  assert.doesNotMatch(composer(true), />Full access</)
  routes = startRoutes(() => session('made', 'full'))
  await useStore.getState().startTask('fix the bug')
  const made = sent('POST', '/api/projects/p/sessions')
  assert.equal(made.length, 1)
  assert.equal((made[0]!.body as { access_mode?: string }).access_mode, undefined)
  await open(session('full-one', 'full'))
  assert.equal(chipOf(composer()), null, 'a Full session\'s composer has no access chip')
  // the mode is still the one every session starts in, untouched by access
  assert.equal((made[0]!.body as { mode?: string }).mode, 'auto')
})

test('a session from before access modes (no access_mode in its answer) shows Sandbox and sends without asking', async () => {
  await open(session('old'), () => ({ status: 404, body: { detail: 'not found' } }))
  const chip = chipOf(composer())
  assert.ok(chip, 'the thread composer has an access chip')
  assert.match(chip!, /data-access="sandbox"/)
  assert.match(composer(), />Sandbox</)
  routes = ((prev) => (call: Call) => (call.method === 'POST' && call.path === '/api/sessions/old/chat' ? { status: 200, body: { id: 'run_2', status: 'running' } } : prev(call)))(routes)
  useStore.setState({ draft: 'go on' })
  await useStore.getState().send('go on')
  assert.equal(sent('POST', '/api/sessions/old/chat').length, 1)
})

test('the page asks nothing before a full-access send: the session is made and its words go at once (the harness asks in the conversation, where a command waits)', async () => {
  routes = startRoutes((body) => session('made', body.access_mode as 'full'))
  await useStore.getState().startTask('first')
  assert.equal(sent('POST', '/api/projects/p/sessions').length, 1)
  assert.equal(sent('POST', '/api/sessions/made/chat').length, 1)
  assert.equal(stored.has('oasis-code.notice.hideFullAccessWarning'), false, 'no confirmation kept on the page')
  await open(session('again', 'full'))
  routes = ((prev) => (call: Call) => (call.method === 'POST' && call.path === '/api/sessions/again/chat' ? { status: 200, body: { id: 'run_3', status: 'running' } } : prev(call)))(routes)
  await useStore.getState().send('more')
  assert.equal(sent('POST', '/api/sessions/again/chat').length, 1)
})

test('Sandbox to Full access is the change itself: one PUT, nothing asked first', async () => {
  const before = session('s', 'sandbox')
  await open(before, (call) => (call.method === 'PUT' ? accessAnswer({ ...before, access_mode: 'full' } as SessionDetail) : accessAnswer(before)))
  assert.equal(await useStore.getState().chooseAccess?.('full'), true)
  assert.equal(sent('PUT', '/api/sessions/s/access').length, 1)
  assert.equal(chipOf(composer()), null, 'back at Full access the chip goes')
})

test('access and mode are separate: a change of access is one PUT /access (never /mode or /grants), a change of grants keeps the access', async () => {
  const before = session('s', 'sandbox')
  await open(before, (call) => (call.method === 'PUT' ? accessAnswer({ ...before, access_mode: 'full' } as SessionDetail) : accessAnswer(before)))
  calls = []
  const changed = await useStore.getState().chooseAccess?.('full')
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`).filter((c) => !c.startsWith('GET')), ['PUT /api/sessions/s/access'])
  assert.equal(changed, true)
  assert.deepEqual(sent('PUT', '/access')[0]!.body, { access_mode: 'full' })
  assert.equal(useStore.getState().session?.access_mode, 'full')
  assert.deepEqual(useStore.getState().session?.grants, grants)
  assert.equal(chipOf(composer()), null)
  // the network off (a grant, as Ask / Plan are): the access stays full
  routes = ((prev) => (call: Call) => (call.method === 'PUT' && call.path === '/api/sessions/s/grants' ? { status: 200, body: { ...before, access_mode: 'full', grants: { ...grants, network: false } } } : prev(call)))(routes)
  calls = []
  await useStore.getState().setGrants({ network: false })
  assert.equal(sent('PUT', '/access').length, 0)
  assert.equal(useStore.getState().session?.access_mode, 'full')
  assert.equal(chipOf(composer()), null)
})

test('a change refused (409: a run outstanding) keeps the access as it was and the chip says why', async () => {
  const s = session('s', 'sandbox')
  await open(s, (call) => (call.method === 'PUT'
    ? { status: 409, body: { detail: 'the session has a run in progress', code: 'access_blocked', blocked_by: { runs: 1, executions: 0, approvals: 0 } } }
    : accessAnswer(s)))
  const changed = await useStore.getState().chooseAccess?.('full')
  assert.equal(sent('PUT', '/api/sessions/s/access').length, 1, 'the change was asked of the harness')
  assert.equal(changed, false)
  assert.equal(useStore.getState().session?.access_mode, 'sandbox')
  const chip = chipOf(composer()) ?? ''
  assert.match(chip, /data-access="sandbox"/)
  assert.match(chip, /title="Stop the active runs first\."/)
  assert.equal(useStore.getState().toast, 'Stop the active runs first.')
  assert.equal(useStore.getState().accessSaving, false)
})

test('nothing crosses sessions: A\'s late answer never lands on B', async () => {
  const a = session('A', 'sandbox'), b = session('B', 'full')
  let release!: (reply: { status: number; body: unknown }) => void
  await open(a, (call) => (call.method === 'PUT' ? new Promise((r) => { release = r }) : accessAnswer(a)))
  const changing = useStore.getState().chooseAccess?.('full')
  await tick()
  assert.equal(sent('PUT', '/api/sessions/A/access').length, 1, 'A\'s change was asked')
  await open(b)
  release(accessAnswer({ ...a, access_mode: 'full' } as SessionDetail))
  await changing
  await tick()
  assert.equal(useStore.getState().session?.id, 'B')
  assert.equal(useStore.getState().access?.session_id, 'B')
  assert.equal(useStore.getState().accessSaving, false)
  assert.equal(useStore.getState().session?.access_mode, 'full')
  assert.equal(chipOf(composer()), null, 'B is Full: no chip, A\'s change never showed on it')
})

test('blocked while a run works; the run ends: the access is read again once (no timer) and the chip offers the change', async () => {
  let running = true
  const live = () => session('s', 'sandbox', running ? { active_run: { id: 'run_live', status: 'running' } } : { active_run: null })
  await open(live(), () => accessAnswer(live(), !running, { runs: running ? 1 : 0, executions: 0, approvals: 0 }))
  assert.equal(sent('GET', '/api/sessions/s/access').length, 1, 'read when the session opened')
  assert.match(chipOf(composer()) ?? '', /title="Stop the active runs first\."/)
  // the run ends (the session as the page's sync takes it in)
  running = false
  useStore.setState({ session: live(), liveRunId: null })
  await tick()
  assert.equal(sent('GET', '/api/sessions/s/access').length, 2, 'read again once the run ended')
  assert.equal(useStore.getState().access?.switchable, true)
  const chip = chipOf(composer()) ?? ''
  assert.doesNotMatch(chip, /title=/)
  assert.match(chip, /data-access="sandbox"/)
  // nothing moved since: no further reads (no polling)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(sent('GET', '/api/sessions/s/access').length, 2)
})

const { UiInputBlock, HarnessAsks } = await import('../src/components/UiInput.tsx')
/** the harness's question as a run's ui_input event carries it (agent/ui_inputs.ts fullAccessRequest) */
const ask = (over: Record<string, unknown> = {}) => ({
  id: 'uin_ask1', session_id: 's', run_id: 'run_1', tool_call_id: 'b1', status: 'pending', values: null, closed_reason: null, created_at: 't', answered_at: null, updated_at: 't',
  request: {
    harness: 'full_access', title: 'Run commands as you on this computer?', root: 'access', initial_state: { access: 'full' }, required: ['access'],
    elements: { access: { type: 'select', props: { label: 'Access', key: 'access', options: [{ label: 'Full access', value: 'full' }, { label: 'Sandbox', value: 'sandbox' }] } } },
  },
  ...over,
}) as never
const block = (record: never) => { asNow(); return renderToStaticMarkup(createElement(UiInputBlock, { record })) }

test("the harness's question waits over the composer (a capsule: one line, two answers, the command under it), not in the conversation; once answered, the conversation says what was chosen", () => {
  assert.equal(block(ask()), '', 'waiting: nothing in the conversation')
  useStore.setState({ uiInputs: { uin_ask1: ask() as never }, threads: { run_1: [{ kind: 'activity', runId: 'run_1', toolCallId: 'b1', tool: 'bash', args: { command: 'python3 -m unittest' } }] } as never, replaying: false })
  asNow()
  const waiting = renderToStaticMarkup(createElement(HarnessAsks))
  assert.match(waiting, /data-testid="full-access-capsule"[^>]*data-state="pending"/)
  assert.ok(waiting.includes('Run commands as you on this computer?'))
  assert.match(waiting, /data-testid="full-access-allow"[^>]*>Allow full access</)
  assert.match(waiting, /data-testid="full-access-sandbox"[^>]*>Use the sandbox</)
  assert.match(waiting, /class="ask-cap open"/)
  assert.match(waiting, /data-testid="full-access-command"[^>]*><span>Command<\/span><code>python3 -m unittest<\/code>/)
  assert.match(waiting, /data-testid="full-access-scope-full"[^>]*><span>Full access<\/span><p>[^<]*This Mac is not asked again\.<\/p>/, 'what a yes covers, and that it is asked once')
  assert.match(waiting, /data-testid="full-access-scope-sandbox"[^>]*><span>Sandbox<\/span><p>[^<]*inside its folder/, 'what the sandbox keeps commands to')
  assert.doesNotMatch(waiting, /data-testid="ui-input"/, 'not drawn as a form')
  useStore.setState({ uiInputs: {}, threads: {} })
  const allowed = block(ask({ status: 'submitted', values: { access: 'full' } }))
  assert.match(allowed, /data-testid="full-access-answer"[^>]*>Full access</)
  assert.doesNotMatch(allowed, /full-access-allow/)
  assert.match(block(ask({ status: 'submitted', values: { access: 'sandbox' } })), /data-testid="full-access-answer"[^>]*>Sandbox</)
})

/** an SSH folder's question as fullAccessRequest(remote) writes it: the host and folder in its message, the scope it confirms */
const remoteAsk = (over: Record<string, unknown> = {}) => ask({
  request: {
    harness: 'remote_full_access', remote_target_id: 'st_1', remote_root_id: 'rr_1', remote_generation: 'g1',
    title: 'Full access', message: 'GPU box (pod-1)\n/workspace', root: 'access', initial_state: { access: 'full' }, required: ['access'],
    elements: { access: { type: 'select', props: { label: 'Access', key: 'access', options: [{ label: 'Full access', value: 'full' }] } } },
  },
  ...over,
})

test("an SSH host's Full access question is the same capsule, never a form that cannot be drawn: allow or decline (no remote sandbox), the host and folder shown", () => {
  assert.equal(block(remoteAsk()), '', 'waiting: nothing in the conversation, no broken form')
  useStore.setState({ uiInputs: { uin_ask1: remoteAsk() as never }, threads: { run_1: [{ kind: 'activity', runId: 'run_1', toolCallId: 'b1', tool: 'bash', args: { command: 'nvidia-smi' } }] } as never, replaying: false })
  asNow()
  const waiting = renderToStaticMarkup(createElement(HarnessAsks))
  assert.match(waiting, /data-testid="full-access-capsule"[^>]*data-state="pending"/)
  assert.ok(waiting.includes('GPU box (pod-1)'), 'the host')
  assert.match(waiting, /data-testid="full-access-folder"[^>]*><span>Folder<\/span><code>\/workspace<\/code>/)
  assert.match(waiting, /data-testid="full-access-command"[^>]*><span>Command<\/span><code>nvidia-smi<\/code>/)
  assert.match(waiting, /data-testid="full-access-allow"[^>]*>Allow full access</)
  assert.match(waiting, /data-testid="full-access-decline"[^>]*>Decline</)
  assert.doesNotMatch(waiting, /full-access-sandbox|Use the sandbox/, 'no remote sandbox to choose')
  assert.doesNotMatch(waiting, /could not be drawn|data-testid="ui-input"/)
  useStore.setState({ uiInputs: {}, threads: {} })
  assert.match(block(remoteAsk({ status: 'submitted', values: { access: 'full' } })), /data-testid="full-access-answer"[^>]*>Full access</)
  assert.match(block(remoteAsk({ status: 'dismissed' })), /data-testid="full-access-answer"[^>]*>Declined</)
})
