import assert from 'node:assert/strict'
import { beforeEach, test, mock } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import type { SessionDetail, Run } from '../src/api/types.ts'
import type { PendingImage } from '../src/state/attachments.ts'
import type { SteerRecord } from '../src/state/steer.ts'

// The application is bundled by Vite; resolve only its extensionless TS imports for Node's store-level tests.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(candidate)) return next(candidate.href, context)
  }
  return next(specifier, context)
} })
const { useStore } = await import('../src/state/store.ts')
const { api, ApiError } = await import('../src/api/client.ts')
const initial = useStore.getState()
const run = (id = 'r1'): Run => ({ id, session_id: 's', status: 'running', parent_run_id: null, work_order: null, relay_id: null, interaction_id: null, model: 'scripted:a', user_text: 'go', attachments: [], receipt: {}, created_at: 'now' } as unknown as Run)
const session = (id = 's'): SessionDetail => ({ id, project_id: 'p', model: 'scripted:a', title: 'test', workspace: null, runs: [run()], director: null, interactions: [], relays: [], director_notes: [], active_run: { id: 'r1', status: 'running', saved_seq: 0, steerable: true } } as unknown as SessionDetail)
const record = (over: Partial<SteerRecord> = {}): SteerRecord => ({ id: 'st_1', run_id: 'r1', session_id: 's', text: 'x', client_request_id: 'k', status: 'queued', queued_at: 't', queued_seq: 4, delivered_at: null, delivered_seq: null, request_index: null, reason: null, ...over })
const image = (): PendingImage => ({ id: 'image1', name: 'data.md', file: new File(['raw data'], 'data.md', { type: 'text/plain' }), url: '', state: 'ready', error: null, uploaded: null })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const refused = (code: string, status = 409) => new ApiError(status, `refused: ${code}`, { detail: `refused: ${code}`, code })

const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) }, clear: () => stored.clear() } })

beforeEach(() => {
  stored.clear()
  mock.restoreAll()
  useStore.setState({ ...initial, session: session(), runs: [run()], threads: { r1: [] }, liveRunId: 'r1', composerTarget: 'agent', images: [], draft: '', composers: {}, interactions: [], relays: [], disposers: {}, childDisposers: {}, noteTo: 'director', noteInteractionId: null, pendingSteer: {} })
  for (const key of ['loadTree', 'refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'syncSession'] as const) useStore.setState({ [key]: async () => {} })
})

test('a steer sends the words exactly, never a new run; the draft leaves only once taken; the queued row joins the run', async () => {
  const words = '  keep  this\n\n  exactly  '
  const bodies: { runId: string; body: { text: string; client_request_id: string } }[] = []
  mock.method(api, 'steer', async (runId: string, body: { text: string; client_request_id: string }) => { bodies.push({ runId, body }); return { run_id: runId, steer: record({ text: body.text, client_request_id: body.client_request_id }) } })
  const chat = mock.method(api, 'chat', async () => { throw new Error('never a new run') })
  const director = mock.method(api, 'sayToDirector', async () => { throw new Error('never the director') })
  useStore.setState({ draft: words })
  await useStore.getState().steer(words, 'r1')
  assert.equal(chat.mock.callCount(), 0)
  assert.equal(director.mock.callCount(), 0)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0]!.runId, 'r1')
  assert.deepEqual(Object.keys(bodies[0]!.body).sort(), ['client_request_id', 'text'])
  assert.equal(bodies[0]!.body.text, words)                                          // not trimmed, not rewritten
  assert.ok(bodies[0]!.body.client_request_id.length >= 8 && bodies[0]!.body.client_request_id.length <= 100)
  assert.equal(useStore.getState().draft, '')
  const rows = useStore.getState().threads.r1!
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.steer?.status, 'queued')
  assert.equal(rows[0]!.steer?.text, words)
})

test('a 409 keeps the draft, starts nothing and releases the route; a lost answer keeps it and the resend reuses the key; other words get a new one', async () => {
  const keys: string[] = []
  let answer: () => Promise<unknown> = async () => { throw refused('run_not_live') }
  mock.method(api, 'steer', async (_runId: string, body: { client_request_id: string }) => { keys.push(body.client_request_id); return answer() })
  const chat = mock.method(api, 'chat', async () => { throw new Error('never a new run after a refusal') })
  useStore.setState({ draft: 'stop using sqlite' })
  await assert.rejects(useStore.getState().steer('stop using sqlite', 'r1'), /ended before your words could join it\. Your draft is kept/)
  assert.equal(useStore.getState().draft, 'stop using sqlite')
  assert.equal(chat.mock.callCount(), 0)
  // a lost answer (the network): the draft stays, the same key goes again — the harness answers with the same record
  answer = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(useStore.getState().steer('stop using sqlite', 'r1'), /sending it again is safe/)
  answer = async () => ({ run_id: 'r1', steer: record({ text: 'stop using sqlite' }) })
  await useStore.getState().steer('stop using sqlite', 'r1')
  assert.notEqual(keys[0], keys[1])                                                   // the harness refused the first: its key is spent
  assert.equal(keys[1], keys[2])                                                      // the lost answer's key goes again
  assert.deepEqual(useStore.getState().pendingSteer, {})
  assert.equal(useStore.getState().draft, '')
  // words changed: a key of their own
  useStore.setState({ draft: 'other words' })
  await useStore.getState().steer('other words', 'r1')
  assert.notEqual(keys[3], keys[0])
})

test('a key the harness holds for other words is spent: the next try mints a new one', async () => {
  const keys: string[] = []
  let first = true
  mock.method(api, 'steer', async (_runId: string, body: { client_request_id: string }) => { keys.push(body.client_request_id); if (first) { first = false; throw refused('key_conflict') } return { run_id: 'r1', steer: record() } })
  useStore.setState({ draft: 'words' })
  await assert.rejects(useStore.getState().steer('words', 'r1'), /draft is kept/)
  assert.equal(useStore.getState().draft, 'words')
  await useStore.getState().steer('words', 'r1')
  assert.notEqual(keys[0], keys[1])
})

test('words typed while the steer is on its way stay; an answer after the person moved away clears only its own session\'s composer', async () => {
  const gate = deferred<unknown>()
  mock.method(api, 'steer', async () => gate.promise)
  useStore.setState({ draft: 'first words' })
  const sent = useStore.getState().steer('first words', 'r1')
  useStore.getState().setDraft('typed meanwhile')
  gate.resolve({ run_id: 'r1', steer: record({ text: 'first words' }) })
  await sent
  assert.equal(useStore.getState().draft, 'typed meanwhile')

  // another session on show when the answer comes: its composer and rows are untouched
  const away = deferred<unknown>()
  mock.method(api, 'steer', async () => away.promise)
  useStore.setState({ draft: 'for s', threads: { r1: [] } })
  const going = useStore.getState().steer('for s', 'r1')
  useStore.setState({ session: session('s2'), draft: 'the other session\'s draft', threads: {}, composers: { s: { draft: 'for s', images: [], relayRounds: 1, orchestration: 'director' } } })
  away.resolve({ run_id: 'r1', steer: record({ text: 'for s' }) })
  await going
  assert.equal(useStore.getState().draft, 'the other session\'s draft')
  assert.equal(useStore.getState().composers.s!.draft, '')
  assert.deepEqual(useStore.getState().threads, {})
})

test('files or a named agent never join a run under way: refused before sending, the draft and the files kept', async () => {
  const steer = mock.method(api, 'steer', async () => ({ run_id: 'r1', steer: record() }))
  useStore.setState({ draft: 'look at this', images: [image()] })
  await assert.rejects(useStore.getState().steer('look at this', 'r1'), /Files cannot join/)
  assert.equal(useStore.getState().images.length, 1)
  assert.equal(useStore.getState().draft, 'look at this')
  useStore.setState({ images: [], draft: 'ask @[Claude](agent:anthropic:claude#pt_1)' })
  await assert.rejects(useStore.getState().steer('ask @[Claude](agent:anthropic:claude#pt_1)', 'r1'), /agent or tool/)
  assert.equal(steer.mock.callCount(), 0)
})

test('the director and participant notes keep their own roads while a run works', async () => {
  const steer = mock.method(api, 'steer', async () => { throw new Error('never steered') })
  const said: unknown[] = []
  mock.method(api, 'sayToDirector', async (_sid: string, body: unknown) => { said.push(body); return { id: 'dt_1' } })
  mock.method(api, 'director', async () => ({ session_id: 's', director: null, turns: [], live: null, transports: [], pending_events: [] }))
  useStore.setState({ composerTarget: 'director', draft: 'for the director' })
  await useStore.getState().send('for the director')
  assert.equal(said.length, 1)
  const ix = { id: 'ix1', status: 'running', participants: [{ id: 'pt_1', label: 'A', model: 'scripted:a' }], nodes: [], notes: [] }
  const noted: unknown[] = []
  mock.method(api, 'noteInteraction', async (id: string, to: string, text: string) => { noted.push({ id, to, text }); return ix })
  useStore.setState({ composerTarget: 'agent', interactions: [ix] as never, noteTo: 'everyone', noteInteractionId: 'ix1', draft: 'a note' })
  await useStore.getState().send('a note')
  assert.deepEqual(noted, [{ id: 'ix1', to: 'everyone', text: 'a note' }])
  assert.equal(steer.mock.callCount(), 0)
})

test('a steer that never reached its run goes back after what the composer holds, never over it', () => {
  useStore.setState({ draft: 'new words' })
  useStore.getState().putBackSteer('s', '  as sent  ')
  assert.equal(useStore.getState().draft, 'new words\n\n  as sent  ')
  // a session not on show: its own composer
  useStore.setState({ composers: { other: { draft: '', images: [], relayRounds: 1, orchestration: 'director' } } })
  useStore.getState().putBackSteer('other', 'x ')
  assert.equal(useStore.getState().composers.other!.draft, 'x ')
  assert.equal(useStore.getState().draft, 'new words\n\n  as sent  ')
})

test('a record read again (the run\'s list after its stream ended) ends a queued steer; an older word or another session\'s never lands', async () => {
  mock.method(api, 'steers', async () => ({ steers: [record({ status: 'undelivered', reason: 'stopped' })] }))
  useStore.setState({ threads: { r1: [{ kind: 'user', runId: 'r1', steer: record(), text: 'x' }] } })
  useStore.getState().adoptSteer(record({ status: 'undelivered', reason: 'stopped' }))
  assert.equal(useStore.getState().threads.r1![0]!.steer?.status, 'undelivered')
  // an older word never moves it back; another session's record never lands here
  useStore.getState().adoptSteer(record())
  assert.equal(useStore.getState().threads.r1![0]!.steer?.status, 'undelivered')
  useStore.getState().adoptSteer(record({ id: 'st_9', session_id: 'elsewhere' }))
  assert.equal(useStore.getState().threads.r1!.length, 1)
})

const { steerRoute, readPendingSteers, PENDING_STEERS_KEY } = await import('../src/state/steer.ts')
/** The composer's road for its words, as Composer.tsx decides it (no live run unless named). */
const routeNow = (destination: 'agent' | 'director' | 'note' = 'agent', liveTarget: string | null = null) =>
  steerRoute({ destination, draft: useStore.getState().draft, pending: useStore.getState().pendingSteer.s, liveTarget })

test('taken, answer lost, run ended: the same words go to the same run with the same key — never a new run; a reload keeps the route', async () => {
  const words = '  the same words  '
  const keys: { runId: string; key: string }[] = []
  let lose = true
  mock.method(api, 'steer', async (runId: string, body: { text: string; client_request_id: string }) => {
    keys.push({ runId, key: body.client_request_id })
    if (lose) throw new TypeError('Failed to fetch')                                  // the harness took it; the answer never came
    return { run_id: runId, steer: record({ text: body.text, client_request_id: body.client_request_id, status: 'delivered' }) }
  })
  const chat = mock.method(api, 'chat', async () => { throw new Error('a duplicate run') })
  useStore.setState({ draft: words })
  await assert.rejects(useStore.getState().steer(words, 'r1'), /sending it again is safe/)
  assert.equal(useStore.getState().draft, words)
  // kept in the page's storage too: a reload (or a session switch) still knows the words' run and key
  assert.deepEqual(readPendingSteers(globalThis.localStorage).s, { session_id: 's', run_id: 'r1', key: keys[0]!.key, text: words })
  assert.ok(stored.get(PENDING_STEERS_KEY))
  // the sync says the run ended: no live run, yet the same words still route to it, with its key
  useStore.setState({ liveRunId: null, runs: [{ ...run(), status: 'done' } as Run], session: { ...session(), active_run: null } as unknown as SessionDetail })
  assert.deepEqual(routeNow(), { run_id: 'r1', key: keys[0]!.key })
  // other words: their own road (here: a new run, as always); words for the director or a note: never taken over
  assert.equal(steerRoute({ destination: 'agent', draft: 'other words', pending: useStore.getState().pendingSteer.s, liveTarget: null }), null)
  assert.equal(routeNow('director'), null)
  assert.equal(routeNow('note'), null)
  lose = false
  await useStore.getState().steer(words, routeNow()!.run_id)
  assert.deepEqual(keys[1], keys[0])
  assert.equal(chat.mock.callCount(), 0)
  assert.deepEqual(useStore.getState().pendingSteer, {})
  assert.equal(useStore.getState().draft, '')
  assert.deepEqual(readPendingSteers(globalThis.localStorage), {})
  assert.equal(routeNow(), null)
})

test('the record heard first by another road (the stream\'s end, a list, a transcript) confirms the lost send; a 409 releases it', async () => {
  let key = ''
  mock.method(api, 'steer', async (_runId: string, body: { client_request_id: string }) => { key = body.client_request_id; throw new TypeError('Failed to fetch') })
  useStore.setState({ draft: 'words' })
  await assert.rejects(useStore.getState().steer('words', 'r1'))
  assert.equal(useStore.getState().pendingSteer.s?.key, key)
  // another session's record, or another key, confirms nothing
  useStore.getState().confirmSteer(record({ client_request_id: 'someone-else', status: 'delivered' }))
  assert.equal(useStore.getState().pendingSteer.s?.key, key)
  // the same key with other words (or another run) is not this send: the route and the draft stay
  useStore.getState().confirmSteer(record({ client_request_id: key, status: 'delivered', text: 'words ' }))
  useStore.getState().confirmSteer(record({ client_request_id: key, status: 'delivered', text: 'words', run_id: 'r2' }))
  assert.equal(useStore.getState().pendingSteer.s?.key, key)
  assert.equal(useStore.getState().draft, 'words')
  useStore.getState().adoptSteer(record({ client_request_id: key, status: 'delivered', text: 'words' }))
  assert.deepEqual(useStore.getState().pendingSteer, {})
  assert.equal(useStore.getState().draft, '')
  // a refusal (the harness answered: not taken) releases the route; the person's next send is their own
  mock.method(api, 'steer', async () => { throw refused('run_not_live') })
  useStore.setState({ draft: 'late words', liveRunId: null })
  await assert.rejects(useStore.getState().steer('late words', 'r1'), /draft is kept/)
  assert.deepEqual(useStore.getState().pendingSteer, {})
  assert.equal(useStore.getState().draft, 'late words')
  assert.equal(routeNow(), null)
})
