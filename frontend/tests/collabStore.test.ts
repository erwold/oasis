import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { CollaborationGraphSchema, isQueuedFollowup, type QueuedFollowup } from '@oasis-code/contract'
import type { Run, SessionDetail } from '../src/api/types.ts'

// The application is bundled by Vite; resolve only its extensionless TS imports for Node's store-level tests.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(candidate)) return next(candidate.href, context)
  }
  return next(specifier, context)
} })
const { useStore, resetRefreshes } = await import('../src/state/store.ts')
const { api, ApiError } = await import('../src/api/client.ts')
const { openCollab } = await import('../src/state/collabSync.ts')
const initial = useStore.getState()
const session = (id = 's'): SessionDetail => ({ id, project_id: 'p', model: 'scripted:a', title: 'test', workspace: null, runs: [], director: null, interactions: [], relays: [], director_notes: [] } as unknown as SessionDetail)
const graph = (revision = 'r1') => CollaborationGraphSchema.parse({
  session_id: 's', revision, main_participant_id: null, actors: [], participants: [], conversations: [], groups: [], runs: [], nodes: [], edges: [], thread_items: [],
  legacy: { projected_runs: 0, inferred_facts: 0, notes: [] },
})
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }

const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) }, clear: () => stored.clear() } })

beforeEach(() => {
  stored.clear()
  mock.restoreAll()
  resetRefreshes() // the tree and graph reads are paced per session (refresher.ts): each test begins unpaced
  useStore.setState({ ...initial, session: session(), composerTarget: 'agent', images: [], draft: '', composers: {}, interactions: [], disposers: {}, childDisposers: {}, noteTo: 'director', noteInteractionId: null, collab: openCollab('s'), toast: null, sendAs: 'main' })
  for (const key of ['loadTree', 'refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'syncSession', 'watchChild', 'watchRun'] as const) useStore.setState({ [key]: async () => {} })
})

test('the graph is read with the revision held: a 304 keeps it; a 500 keeps it, is said once and retried; a 404 is an older harness, said nothing', async () => {
  const reads: (string | null | undefined)[] = []
  let answer: () => Promise<unknown> = async () => graph('r1')
  mock.method(api, 'collaboration', async (_sid: string, rev?: string | null) => { reads.push(rev); return answer() })
  await useStore.getState().loadCollab()
  assert.equal(useStore.getState().collab.revision, 'r1')
  answer = async () => ({ unchanged: true })
  await useStore.getState().loadCollab()
  assert.deepEqual(reads, [null, 'r1'])
  assert.equal(useStore.getState().collab.graph?.revision, 'r1')
  answer = async () => { throw new ApiError(500, 'database busy', null) }
  await useStore.getState().loadCollab()
  assert.match(useStore.getState().toast ?? '', /\(500\): database busy/)
  assert.equal(useStore.getState().collab.graph?.revision, 'r1')                            // what was on show stays
  useStore.setState({ toast: null })
  await useStore.getState().loadCollab()
  assert.equal(useStore.getState().toast, null)                                              // not said on every retry
  answer = async () => graph('r2')
  await useStore.getState().loadCollab()
  assert.equal(useStore.getState().collab.error, null)
  useStore.setState({ collab: openCollab('s') })
  answer = async () => { throw new ApiError(404, 'Not Found', null) }
  await useStore.getState().loadCollab()
  assert.equal(useStore.getState().collab.status, 'legacy')
  assert.equal(useStore.getState().toast, null)
  const before = reads.length
  await useStore.getState().loadCollab()
  assert.equal(reads.length, before)                                                         // an older harness is not asked again
})

test('an answer for a session left, or overtaken by a later read, is dropped', async () => {
  const first = deferred<unknown>()
  const calls: string[] = []
  mock.method(api, 'collaboration', (sid: string) => { calls.push(sid); return calls.length === 1 ? first.promise : Promise.resolve({ ...graph('r-B'), session_id: sid }) })
  const loadingA = useStore.getState().loadCollab()
  useStore.setState({ session: session('B'), collab: openCollab('B') })
  await useStore.getState().loadCollab()
  first.resolve({ ...graph('r-A'), session_id: 's' })
  await loadingA
  assert.equal(useStore.getState().collab.sessionId, 'B')
  assert.equal(useStore.getState().collab.revision, 'r-B')
})

test('a separate task goes to /work-orders with workspace_policy isolated — never /chat; the same words again reuse the key; the default then is the main agent again', async () => {
  const chat = mock.method(api, 'chat', async () => { throw new Error('wrong endpoint') })
  const bodies: Record<string, unknown>[] = []
  let fail = true
  mock.method(api, 'workOrder', async (_sid: string, body: Record<string, unknown>) => { bodies.push(body); if (fail) { fail = false; throw new Error('answer lost') } return { id: 'run_sep', status: 'queued' } as Run })
  mock.method(api, 'collaboration', async () => graph())
  useStore.setState({ sendAs: 'separate', draft: 'Fix the lint errors\nin src/', modelChoice: 'scripted:c', thinking: 'high' })
  await assert.rejects(useStore.getState().sendSeparate('Fix the lint errors\nin src/'), /answer lost/)
  assert.equal(useStore.getState().draft, 'Fix the lint errors\nin src/')                     // kept while not taken
  const run = await useStore.getState().sendSeparate('Fix the lint errors\nin src/')
  assert.equal(run?.id, 'run_sep')
  assert.equal(chat.mock.callCount(), 0)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0]!.client_request_id, bodies[1]!.client_request_id)
  assert.deepEqual({ ...bodies[1], client_request_id: 'k' }, { work_order: { prompt: 'Fix the lint errors\nin src/', label: 'Fix the lint errors', model: 'scripted:c' }, thinking: 'high', client_request_id: 'k', workspace_policy: 'isolated' })
  assert.equal(useStore.getState().draft, '')
  assert.equal(useStore.getState().sendAs, 'main')
})

test('a harness without the separate-task route keeps the draft and says so — nothing is sent another way', async () => {
  const chat = mock.method(api, 'chat', async () => ({ id: 'run_x', status: 'queued' }) as Run)
  mock.method(api, 'workOrder', async () => { throw new ApiError(404, 'Not Found', null) })
  useStore.setState({ sendAs: 'separate', draft: 'a task' })
  await assert.rejects(useStore.getState().sendSeparate('a task'), /does not take separate tasks \(404\)\. Nothing was sent; the draft is kept/)
  assert.equal(chat.mock.callCount(), 0)
  assert.equal(useStore.getState().draft, 'a task')
  assert.equal(useStore.getState().sendAs, 'separate')
  // files and named agents are refused before anything leaves
  useStore.setState({ images: [{ id: 'i', name: 'a.png' }] as never })
  await assert.rejects(useStore.getState().sendSeparate('a task'), /takes words only/)
})

test("a card's follow-up: the participant's route with the head it saw and a key a retry reuses; another head is another message; a 409 keeps the words", async () => {
  useStore.setState({ collab: { ...openCollab('s'), status: 'graph', graph: graph(), revision: 'r1' } })
  mock.method(api, 'collaboration', async () => ({ unchanged: true }))
  const resume = mock.method(api, 'resume', async () => { throw new Error('wrong endpoint') })
  const bodies: { pid: string; body: Record<string, unknown> }[] = []
  let attempt = 0
  mock.method(api, 'participantMessage', async (pid: string, body: Record<string, unknown>) => {
    bodies.push({ pid, body }); attempt += 1
    if (attempt === 1) throw new Error('answer lost')
    if (attempt === 4) throw new ApiError(409, 'head_moved', { detail: 'head_moved' })
    return { id: `run_f${attempt}`, status: 'queued' } as Run
  })
  const send = { participantId: 'pa_3333333333333333', headRunId: 'run_13', text: 'and the tests', model: null }
  await assert.rejects(useStore.getState().continueParticipant(send), /answer lost/)
  const first = await useStore.getState().continueParticipant(send)
  assert.ok(!isQueuedFollowup(first))
  assert.equal(first.id, 'run_f2')
  assert.equal(bodies[0]!.body.client_request_id, bodies[1]!.body.client_request_id)
  assert.equal(bodies[1]!.pid, 'pa_3333333333333333')
  assert.equal(bodies[1]!.body.expected_head_run_id, 'run_13')
  assert.equal(bodies[1]!.body.text, 'and the tests')
  // the next follow-up, at the head that run made: a new key
  await useStore.getState().continueParticipant({ ...send, headRunId: 'run_f2' })
  assert.notEqual(bodies[2]!.body.client_request_id, bodies[1]!.body.client_request_id)
  await assert.rejects(useStore.getState().continueParticipant({ ...send, headRunId: 'run_f3', text: 'again' }), /head_moved — the card was read again; your words are kept/)
  assert.equal(resume.mock.callCount(), 0)
})

test("an older harness: a card's follow-up continues the run itself through /resume, with a key", async () => {
  useStore.setState({ collab: { ...openCollab('s'), status: 'legacy' } })
  const participant = mock.method(api, 'participantMessage', async () => { throw new Error('wrong endpoint') })
  const resume = mock.method(api, 'resume', async () => ({ id: 'run_r', status: 'queued' }) as Run)
  await useStore.getState().continueParticipant({ participantId: null, headRunId: 'run_02', text: 'more', model: 'scripted:b' })
  assert.equal(participant.mock.callCount(), 0)
  assert.equal(resume.mock.calls[0]!.arguments[0], 'run_02')
  const body = resume.mock.calls[0]!.arguments[1] as Record<string, unknown>
  assert.equal(body.text, 'more')
  assert.equal(body.model, 'scripted:b')
  assert.equal(typeof body.client_request_id, 'string')
})

test('a discussion from the composer: the discussion template with its exchange rounds, the policy said; its key is not a guided one', async () => {
  const started: Record<string, unknown>[] = []
  mock.method(api, 'startInteraction', async (_sid: string, body: Record<string, unknown>) => { started.push(body); return { id: `ix_${started.length}`, director_session_id: null } as never })
  mock.method(api, 'director', async () => ({ director: null, turns: [] }))
  const { agentMentionToken } = await import('../src/state/entities.ts')
  const text = `compare ${agentMentionToken('A', 'scripted:a')} and ${agentMentionToken('B', 'scripted:b')}`
  useStore.setState({ orchestration: 'discussion', crossRounds: 2, draft: text })
  await useStore.getState().send(text)
  useStore.setState({ orchestration: 'director', draft: text })
  await useStore.getState().send(text)
  const [discussion, guided] = started
  assert.deepEqual(discussion!.plan, { template: 'discussion', cross_rounds: 2 })
  assert.equal(discussion!.workspace_policy, 'legacy')
  assert.equal(guided!.plan, null)
  assert.notEqual(discussion!.client_request_id, guided!.client_request_id)
})

test('references: two lists to a harness that records them, cleared only once taken; refused — never dropped in silence — where they cannot go; one run is one or the other', async () => {
  const bodies: Record<string, unknown>[] = []
  let fail = false
  mock.method(api, 'chat', async (_sid: string, body: Record<string, unknown>) => { bodies.push(body); if (fail) throw new Error('answer lost'); return { id: `run_m${bodies.length}`, status: 'queued', relay_id: null } as Run })
  mock.method(api, 'collaboration', async () => ({ unchanged: true }))
  const say = mock.method(api, 'sayToDirector', async () => ({ id: 'dt_x' }))
  const started: Record<string, unknown>[] = []
  mock.method(api, 'startInteraction', async (_sid: string, body: Record<string, unknown>) => { started.push(body); return { id: 'ix_r', director_session_id: null } as never })
  mock.method(api, 'director', async () => ({ director: null, turns: [] }))
  const s = useStore.getState()
  s.toggleReference('run_a', 'cite')
  s.toggleReference('run_b', 'cite')
  s.toggleReference('run_b', 'receive')                                                        // the later choice wins: handed over, not also cited
  const refs = { cites: [{ run_id: 'run_a' }], receive: ['run_b'] }
  assert.deepEqual(useStore.getState().references, refs)
  // an older harness (or a graph read that failed): refused, the draft and the references kept
  useStore.setState({ collab: { ...openCollab('s'), status: 'legacy' }, draft: 'go on' })
  await assert.rejects(useStore.getState().send('go on'), /does not record cited or handed-over runs.*draft is kept/)
  assert.equal(bodies.length, 0)
  assert.deepEqual(useStore.getState().references, refs)
  // the director and notes take none: refused, nothing sent
  useStore.setState({ collab: { ...openCollab('s'), status: 'graph', graph: graph(), revision: 'r1' }, composerTarget: 'director' })
  await assert.rejects(useStore.getState().send('go on'), /the director takes none/)
  assert.equal(say.mock.callCount(), 0)
  useStore.setState({ composerTarget: 'agent' })
  // a group takes cited runs only: one handed over is refused, not stripped
  const { agentMentionToken } = await import('../src/state/entities.ts')
  const group = `compare ${agentMentionToken('A', 'scripted:a')} and ${agentMentionToken('B', 'scripted:b')}`
  useStore.setState({ orchestration: 'independent', draft: group })
  await assert.rejects(useStore.getState().send(group), /A group takes cited runs only/)
  assert.equal(started.length, 0)
  // a failed send keeps them; the retry carries the same key and the same lists; taken, they leave
  useStore.setState({ draft: 'go on' })
  fail = true
  await assert.rejects(useStore.getState().send('go on'), /answer lost/)
  assert.deepEqual(useStore.getState().references, refs)
  fail = false
  await useStore.getState().send('go on')
  assert.deepEqual(bodies[1]!.cites, [{ run_id: 'run_a' }])
  assert.deepEqual(bodies[1]!.receive_run_ids, ['run_b'])
  assert.equal(bodies[0]!.client_request_id, bodies[1]!.client_request_id)
  assert.deepEqual(useStore.getState().references, { cites: [], receive: [] })
  // the same words without references are another message
  useStore.setState({ draft: 'go on' })
  await useStore.getState().send('go on')
  assert.notEqual(bodies[2]!.client_request_id, bodies[1]!.client_request_id)
  assert.equal('cites' in bodies[2]!, false)
  // a group with a cited run: the cites go with it
  useStore.getState().toggleReference('run_a', 'cite')
  useStore.setState({ draft: group })
  await useStore.getState().send(group)
  assert.deepEqual(started[0]!.cites, [{ run_id: 'run_a' }])
  assert.equal('receive_run_ids' in started[0]!, false)
  // a relay (turns) takes both, on /chat
  useStore.getState().toggleReference('run_a', 'cite'); useStore.getState().toggleReference('run_b', 'receive')
  useStore.setState({ orchestration: 'turns', draft: group })
  await useStore.getState().send(group)
  assert.deepEqual(bodies.at(-1)!.cites, [{ run_id: 'run_a' }])
  assert.deepEqual(bodies.at(-1)!.receive_run_ids, ['run_b'])
  assert.ok(Array.isArray(bodies.at(-1)!.agents))
})

test("a group's workspace policy: the session's own rule by default, isolated when chosen; captured with the message and part of its key — a retry never goes under another policy", async () => {
  const started: Record<string, unknown>[] = []
  let fail = true
  mock.method(api, 'startInteraction', async (_sid: string, body: Record<string, unknown>) => { started.push(body); if (fail) { fail = false; throw new Error('answer lost') } return { id: `ix_${started.length}`, director_session_id: null } as never })
  mock.method(api, 'director', async () => ({ director: null, turns: [] }))
  const { agentMentionToken } = await import('../src/state/entities.ts')
  const text = `compare ${agentMentionToken('A', 'scripted:a')} and ${agentMentionToken('B', 'scripted:b')}`
  assert.equal(useStore.getState().groupPolicy, 'legacy')
  useStore.setState({ orchestration: 'independent', draft: text })
  await assert.rejects(useStore.getState().send(text), /answer lost/)
  assert.equal(started[0]!.workspace_policy, 'legacy')
  useStore.getState().setGroupPolicy('isolated')
  await useStore.getState().send(text)
  assert.equal(started[1]!.workspace_policy, 'isolated')
  assert.notEqual(started[1]!.client_request_id, started[0]!.client_request_id)              // another policy: another message
  useStore.getState().setGroupPolicy('legacy')
  useStore.setState({ draft: text })
  await useStore.getState().send(text)
  assert.equal(started[2]!.workspace_policy, 'legacy')
  assert.equal(started[2]!.client_request_id, started[0]!.client_request_id)                  // the first message again, its own key
  // a message captured before the person changed the policy goes as it was captured
  const captured = { ...useStore.getState(), images: [], groupPolicy: 'isolated' as const, orchestration: 'discussion' as const, crossRounds: 3 }
  useStore.getState().setGroupPolicy('legacy')
  await useStore.getState().send(text, undefined, captured)
  assert.equal(started[3]!.workspace_policy, 'isolated')
  assert.deepEqual(started[3]!.plan, { template: 'discussion', cross_rounds: 3 })
})

test('a separate task with references: refused while the harness records none; with a graph, both lists at the top level, kept until taken', async () => {
  const bodies: Record<string, unknown>[] = []
  mock.method(api, 'workOrder', async (_sid: string, body: Record<string, unknown>) => { bodies.push(body); return { id: 'run_s', status: 'queued' } as Run })
  mock.method(api, 'collaboration', async () => ({ unchanged: true }))
  useStore.getState().toggleReference('run_a', 'cite')
  useStore.getState().toggleReference('run_b', 'receive')
  useStore.setState({ collab: { ...openCollab('s'), status: 'error' }, draft: 'task' })
  await assert.rejects(useStore.getState().sendSeparate('task'), /does not record cited/)
  assert.equal(bodies.length, 0)
  useStore.setState({ collab: { ...openCollab('s'), status: 'graph', graph: graph(), revision: 'r1' } })
  await useStore.getState().sendSeparate('task')
  assert.deepEqual(bodies[0]!.cites, [{ run_id: 'run_a' }])
  assert.deepEqual(bodies[0]!.receive_run_ids, ['run_b'])
  assert.equal(bodies[0]!.workspace_policy, 'isolated')
  assert.deepEqual(useStore.getState().references, { cites: [], receive: [] })
})

test("a member's follow-up the harness queued (202): the step comes back as it is — no run id read, nothing watched; the key is the harness's, the same send again is that step", async () => {
  useStore.setState({ collab: { ...openCollab('s'), status: 'graph', graph: graph(), revision: 'r1' } })
  mock.method(api, 'collaboration', async () => ({ unchanged: true }))
  const watched: string[] = []
  let trees = 0
  useStore.setState({ watchChild: async (id: string) => { watched.push(id) }, loadTree: async () => { trees += 1 } })
  const queued: QueuedFollowup = { queued: true, interaction_id: 'ix_1', node_id: 'fu-2', participant_id: 'pa_3333333333333333' }
  const bodies: Record<string, unknown>[] = []
  let attempt = 0
  mock.method(api, 'participantMessage', async (_pid: string, body: Record<string, unknown>) => {
    bodies.push(body); attempt += 1
    if (attempt === 1) throw new Error('answer lost')
    return queued
  })
  const send = { participantId: 'pa_3333333333333333', headRunId: 'run_13', text: 'one more pass', model: null }
  await assert.rejects(useStore.getState().continueParticipant(send), /answer lost/)
  const answer = await useStore.getState().continueParticipant(send)
  assert.ok(isQueuedFollowup(answer))
  assert.deepEqual(answer, queued)
  assert.equal(bodies[0]!.client_request_id, bodies[1]!.client_request_id)            // the retry after a lost answer: the same key
  assert.deepEqual(watched, [])                                                        // no run to watch, no "undefined" listened to
  assert.ok(trees >= 1)                                                                 // the tree is read again: the step shows
  // taken: the next send of other words is another message (a new key)
  await useStore.getState().continueParticipant({ ...send, text: 'and another' })
  assert.notEqual(bodies[2]!.client_request_id, bodies[1]!.client_request_id)
})

test('the API client reads a 202 follow-up as the queued step and a 200 as the Run; anything else is refused as malformed', async () => {
  const answers: { status: number; body: unknown }[] = []
  const calls: { url: string; method: string }[] = []
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method) })
    const next = answers.shift()!
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  })
  const queued = { queued: true, interaction_id: 'ix_1', node_id: 'fu-1', participant_id: 'pa_1' }
  answers.push({ status: 202, body: queued }, { status: 200, body: { id: 'run_1', status: 'running' } }, { status: 202, body: queued }, { status: 200, body: { queued: true } })
  assert.deepEqual(await api.participantMessage('pa_1', { text: 'x', attachments: [] }), queued)
  assert.equal(((await api.participantMessage('pa_1', { text: 'x', attachments: [] })) as Run).id, 'run_1')
  assert.deepEqual(await api.resume('run_0', { text: 'x' }), queued)
  await assert.rejects(api.resume('run_0', { text: 'x' }), /malformed run/)
  assert.deepEqual(calls.map((c) => c.url), ['/api/participants/pa_1/messages', '/api/participants/pa_1/messages', '/api/runs/run_0/resume', '/api/runs/run_0/resume'])
})
