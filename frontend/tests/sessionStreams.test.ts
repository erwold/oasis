import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import type { Run, SessionDetail } from '../src/api/types.ts'

/** The page's connections and reads with many agents at work (the store as the app drives it): a session with 24 live
 *  runs is followed on ONE EventSource (a browser keeps six per host over HTTP/1.1; one per run left none for the
 *  page's own requests), each run's events reach its own thread and no other's; and a burst of asks for the run tree
 *  and the collaboration graph — what 24 runs ending at once set off — is a read or two, not one per ask. */

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(candidate)) return next(candidate.href, context)
  }
  return next(specifier, context)
} })

/** An EventSource the test drives: every one made is kept, with its URL and whether it was closed. */
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
const stored = new Map<string, string>()
Object.assign(globalThis, {
  EventSource: FakeSource,
  window: { addEventListener() {}, removeEventListener() {} },
  document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
})
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) }, clear: () => stored.clear() } })

const { useStore } = await import('../src/state/store.ts')
const { api } = await import('../src/api/client.ts')
const initial = useStore.getState()
const AGENTS = 24
const runIds = Array.from({ length: AGENTS }, (_, i) => `run_${i}`)
const run = (id: string): Run => ({ id, session_id: 's', status: 'running', model: 'scripted:a', user_text: id } as unknown as Run)
const detail = (): SessionDetail => ({
  id: 's', project_id: 'p', model: 'scripted:a', title: 'agents', workspace: null, runs: runIds.map(run), director: null, interactions: [], relays: [],
  director_notes: [], active_run: null, active_children: [], run_count: AGENTS, pending_approvals: [], event_cursor: 40,
} as unknown as SessionDetail)
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  stored.clear()
  mock.restoreAll()
  useStore.getState().closeSession()
  FakeSource.made = []
  useStore.setState({ ...initial })
  for (const key of ['refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'syncSession', 'loadDirector'] as const) useStore.setState({ [key]: async () => {} })
  mock.method(api, 'session', async () => detail())
  mock.method(api, 'run', async (id: string) => run(id))
  mock.method(api, 'tree', async () => ({ session_id: 's', runs: [] }))
  mock.method(api, 'collaboration', async () => { throw Object.assign(new Error('Not Found'), { status: 404 }) })
})

test(`a session with ${AGENTS} live agents holds one EventSource; each run's events reach its own thread only`, async () => {
  await useStore.getState().openSession('s')
  await settle()
  const open = FakeSource.made.filter((s) => !s.closed)
  assert.equal(open.length, 1, `EventSources open for ${AGENTS} live runs: ${open.length} (${open.slice(0, 3).map((s) => s.url).join(', ')}…)`)
  const [stream] = open
  assert.match(stream!.url, /^\/api\/sessions\/s\/events\?after=40$/)
  // the server's replay of what each run said, then stream_ready, then the runs talking at once
  let cursor = 40
  for (const id of runIds) stream!.emit('run_started', { run_id: id, seq: 0, data: {} }, String(++cursor))
  stream!.emit('stream_ready', { cursor, live_runs: runIds }, String(cursor))
  for (const [i, id] of runIds.entries()) stream!.emit('text_block', { run_id: id, seq: 1, data: { text: `answer of agent ${i}` } }, String(++cursor))
  await settle()
  const threads = useStore.getState().threads
  for (const [i, id] of runIds.entries()) {
    const said = JSON.stringify(threads[id] ?? [])
    assert.match(said, new RegExp(`answer of agent ${i}\\b`), `${id} heard its own words`)
    assert.equal((said.match(/answer of agent \d+/g) ?? []).length, 1, `${id} heard no other agent's words`)
  }
  // a reconnect replays after its cursor: what was heard once is not applied twice
  stream!.emit('text_block', { run_id: 'run_0', seq: 1, data: { text: 'answer of agent 0' } }, String(cursor))
  await settle()
  assert.equal((JSON.stringify(useStore.getState().threads.run_0).match(/answer of agent 0\b/g) ?? []).length, 1)
  useStore.getState().closeSession()
  assert.equal(FakeSource.made.filter((s) => !s.closed).length, 0, 'leaving the session closes its stream')
})

test(`a burst of asks for the tree and the graph (${AGENTS} runs ending at once, 4 asks each) is paced: a read or two, and an ask awaited after it sees a read begun after it`, async () => {
  let trees = 0, graphs = 0
  let treeVersion = 0
  mock.method(api, 'tree', async () => { trees += 1; const version = ++treeVersion; await settle(5); return { session_id: 's', runs: [{ id: `v${version}`, session_id: 's', status: 'done', spawned_by: 'human_action', lineage: [] }] } })
  mock.method(api, 'collaboration', async () => { graphs += 1; await settle(5); return { unchanged: true } })
  useStore.setState({ session: detail(), collab: { ...useStore.getState().collab, sessionId: 's', status: 'graph', graph: null } as never })
  const asks: Promise<void>[] = []
  for (let i = 0; i < AGENTS * 4; i += 1) { asks.push(useStore.getState().loadTree()); asks.push(useStore.getState().loadCollab()) }
  const askedAt = treeVersion
  await Promise.all(asks)
  console.log(`store: ${AGENTS * 4} asks each -> ${trees} tree reads, ${graphs} graph reads`)
  assert.ok(trees <= 2, `tree reads for ${AGENTS * 4} asks: ${trees}`)
  assert.ok(graphs <= 2, `graph reads for ${AGENTS * 4} asks: ${graphs}`)
  // the last ask resolved with a read that began after it: the tree on show is newer than what was asked over
  assert.ok(treeVersion > askedAt, 'an ask is answered by a read begun after it')
  assert.equal(useStore.getState().tree[0]?.id, `v${treeVersion}`)
})
