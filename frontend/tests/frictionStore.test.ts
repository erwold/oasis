/** Store-level regressions of the friction cleanup (2026-10-16): a note to one of several groups goes only where the
 *  person chose (17) — no first group chosen for them, never the director when the chosen one closed; a run waiting
 *  for the folder is cancelled by its own id (13); a session's folders are added with the access chosen and shown as
 *  the harness registered them. New store actions are read loosely so this file runs against the store before them. */
import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import type { SessionDetail } from '../src/api/types.ts'

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(candidate)) return next(candidate.href, context)
  }
  return next(specifier, context)
} })
const { useStore } = await import('../src/state/store.ts')
const { api } = await import('../src/api/client.ts')
const initial = useStore.getState()
type Loose = Record<string, unknown>
const action = <T>(name: string): T => (useStore.getState() as unknown as Loose)[name] as T
const session = (id = 's', over: Loose = {}): SessionDetail => ({ id, project_id: 'p', model: 'scripted:a', title: 'test', workspace: null, runs: [], director: null, interactions: [], relays: [], director_notes: [], ...over } as unknown as SessionDetail)
const group = (id: string, status: string, created_at: string) => ({ id, status, created_at, user_text: id, participants: [{ id: 'A', label: 'A', model: 'a' }], nodes: [] })

const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) }, clear: () => stored.clear() } })

beforeEach(() => {
  stored.clear()
  stored.set('oasis-code.notice.hideFullAccessWarning', '1')
  mock.restoreAll()
  useStore.setState({ ...initial, session: session(), composerTarget: 'director', images: [], draft: '', composers: {}, interactions: [], disposers: {}, childDisposers: {}, noteTo: 'director', noteInteractionId: null, toast: null })
  for (const key of ['loadTree', 'refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'syncSession'] as const) useStore.setState({ [key]: async () => {} })
  mock.method(api, 'director', async () => ({ session_id: 's', director: null, turns: [], live: null, transports: [], pending_events: [] }))
})

test('17: with two groups open, naming a recipient without its group chooses none (the first is not taken for the person)', () => {
  useStore.setState({ interactions: [group('ix_a', 'running', '2026-10-16T01:00:00Z'), group('ix_b', 'running', '2026-10-16T02:00:00Z')] as never })
  assert.throws(() => useStore.getState().setNoteTo('everyone'), /group/i)
  assert.equal(useStore.getState().noteInteractionId, null)
  assert.equal(useStore.getState().noteTo, 'director')
})

test('17: the group chosen is the group written to, whichever was made first', async () => {
  useStore.setState({ interactions: [group('ix_a', 'running', '2026-10-16T01:00:00Z'), group('ix_b', 'running', '2026-10-16T02:00:00Z')] as never })
  const note = mock.method(api, 'noteInteraction', async (id: string) => ({ id, status: 'running' }))
  const say = mock.method(api, 'sayToDirector', async () => ({ id: 'dt_1' }))
  ;(useStore.getState().setNoteTo as (to: string, interactionId?: string) => void)('A', 'ix_b')
  assert.equal(useStore.getState().noteInteractionId, 'ix_b')
  await useStore.getState().send('to the second group')
  assert.deepEqual(note.mock.calls.map((c) => c.arguments), [['ix_b', 'A', 'to the second group']])
  assert.equal(say.mock.callCount(), 0)
})

test('17: the chosen group closed before sending: refused with the draft kept — nothing goes to the director or to another group', async () => {
  useStore.setState({ interactions: [group('ix_a', 'running', '2026-10-16T01:00:00Z')] as never })
  useStore.getState().setNoteTo('everyone')
  assert.equal(useStore.getState().noteInteractionId, 'ix_a')
  useStore.setState({ interactions: [group('ix_a', 'cancelled', '2026-10-16T01:00:00Z'), group('ix_new', 'running', '2026-10-16T03:00:00Z')] as never, draft: 'keep me' })
  const say = mock.method(api, 'sayToDirector', async () => ({ id: 'dt_1' }))
  const note = mock.method(api, 'noteInteraction', async (id: string) => ({ id, status: 'running' }))
  const chat = mock.method(api, 'chat', async () => ({ id: 'run_1', status: 'running' }))
  await assert.rejects(useStore.getState().send('keep me'), /no longer/i)
  assert.equal(say.mock.callCount(), 0)
  assert.equal(note.mock.callCount(), 0)
  assert.equal(chat.mock.callCount(), 0)
  assert.equal(useStore.getState().draft, 'keep me')
})

test('13: a waiting run is cancelled by its own id, whichever run the thread follows', async () => {
  const cancel = mock.method(api, 'cancel', async () => ({ cancelled: true }))
  useStore.setState({ liveRunId: 'run_thread' })
  const cancelRun = action<((id: string) => Promise<void>) | undefined>('cancelRun')
  assert.equal(typeof cancelRun, 'function')
  await cancelRun!('run_waiting')
  assert.deepEqual(cancel.mock.calls.map((c) => c.arguments), [['run_waiting']])
})

test('13: a command holding the folder (a finished run\'s background writer) is stopped by its execution id', async () => {
  const sent: string[] = []
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => { sent.push(`${init?.method ?? 'GET'} ${String(url)}`); return Response.json({ stopped: true }) })
  const stop = action<((id: string) => Promise<boolean>) | undefined>('stopExecution')
  assert.equal(typeof stop, 'function')
  assert.equal(await stop!('exec_7'), true)
  assert.deepEqual(sent, ['POST /api/executions/exec_7/stop'])
})

test('folders changed elsewhere (another window, the director) are taken in on the session\'s own sync, without a run moving; the page never asks the folders\' own route', async () => {
  useStore.setState({ session: session('s', { roots: [{ path: '/work/a', access: 'read' }] }), syncSession: initial.syncSession } as never)
  let rootsAsked = 0
  let detailRoots: unknown[] = [{ path: '/work/a', access: 'read' }]
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    const u = String(url)
    if (u === '/api/sessions/s/roots') { rootsAsked += 1; return Response.json({}) }
    if (u === '/api/sessions/s') return Response.json(session('s', { roots: detailRoots }))
    return Response.json({})
  })
  const settle = () => new Promise((r) => setTimeout(r, 20))
  detailRoots = [{ path: '/work/a', access: 'write' }, { path: '/work/b', access: 'read' }]
  await useStore.getState().syncSession()
  await settle()
  assert.deepEqual((useStore.getState().session as unknown as Loose).roots, [{ path: '/work/a', access: 'write' }, { path: '/work/b', access: 'read' }])
  assert.equal(rootsAsked, 0)
})
