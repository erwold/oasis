/** director.v2 in use, and the fixes both surfaces carry. Through the real native transport, the in-memory MCP server
 *  and the app's REST API (every request the director's tools make is recorded as it reaches the API): a separate
 *  task goes isolated, a relay is the composer's relay, a session the director creates joins its reach and nothing
 *  else does, a citation or a handed-over answer never crosses sessions, the original message applies only where a
 *  call names it, one tool call is one request key and one key never stands for two requests, an answer is read
 *  whole by pages from the exact run, a run's end is told by its origin. The connector's side is tested against a
 *  recorded HTTP harness where the core API it needs is not in this branch (cites and received answers recorded,
 *  the collaboration routes) — those calls' end-to-end effect is checked after integration. Scripted models, no
 *  network. */

import { afterEach, expect, test } from 'bun:test'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CURRENT_DIRECTOR_TOOL_SURFACE, type DirectorDetail, type DirectorOutboxEvent, type DirectorTurn, type Run } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { announcesRun } from '../src/director/controller.ts'
import { DIRECTOR_SESSION_HEADER, DIRECTOR_TOOL_CALL_HEADER, DIRECTOR_TURN_HEADER, Harness, TOOL_SURFACE_HEADER } from '../src/director/harness.ts'
import { taskEventMessage } from '../src/director/outbox.ts'
import { namedThings, scopeRefusal } from '../src/director/scope.ts'
import { buildServer } from '../src/director/server.ts'
import * as store from '../src/director/store.ts'
import { nativeRequestKey } from '../src/director/tools.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { asLegacyV1, onSurface } from './director_surface_fixtures.ts'
import { buggyRepo, scriptedModel, setModel, sleep, steps, waitDone } from './harness.ts'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

let app: App | null = null
let mcp: McpClient | null = null
afterEach(async () => {
  if (mcp) await mcp.close()
  mcp = null
  if (app) await app.close()
  app = null
})

interface Recorded { method: string; path: string; headers: Record<string, string>; body: Rec | null }

/** An app whose native director's requests are recorded as they reach the API. */
async function recordingApp(): Promise<{ c: Client; recorded: Recorded[] }> {
  app = await makeApp()
  const a = app
  const recorded: Recorded[] = []
  a.state.director.attachHarness(async (input, init) => {
    const url = new URL(String(input))
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    let body: Rec | null = null
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body) as Rec } catch { body = null } }
    recorded.push({ method: init?.method ?? 'GET', path: url.pathname, headers, body })
    return a.app.request(input, init)
  })
  return { c: new Client(a), recorded }
}

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 800)}`)
    await sleep(25)
  }
}
const turnDone = (c: Client, id: string) => waitFor(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${id}`)), (t) => ['done', 'error', 'cancelled'].includes(t.status), `turn ${id}`)

async function projectWithSession(c: Client, title = 'v2'): Promise<{ project: Rec; sid: string }> {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title, model: 'scripted:a' }))
  return { project, sid: String(session.id) }
}

async function openV2(c: Client, sid: string): Promise<string> {
  if (!app!.state.model_overrides.has('scripted:b')) setModel(app!.state, 'scripted:b', scriptedModel(() => modelResponse([textPart('placeholder')])))
  const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b', config: { allow_destructive: false } }))
  // a new session opens on the newest surface; these tests pin director.v2's behaviour on a v2 conversation
  expect(opened.director!.tool_surface).toBe(CURRENT_DIRECTOR_TOOL_SURFACE)
  onSurface(app!.state.conn, opened.director!.id, 'director.v2')
  return opened.director!.id
}

/** A separate run of the session, started by the person, ended. */
async function endedSeparate(c: Client, sid: string, prompt: string): Promise<string> {
  const run = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt } }))
  await waitDone(app!.state, String(run.id))
  return String(run.id)
}

// ---- native v2 -----------------------------------------------------------------------------------------------------

test('native v2: a separate task goes isolated, a relay is the composer\'s relay; each request carries its director call', async () => {
  const { c, recorded } = await recordingApp()
  const st = app!.state
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('agent answer')])))
  const { sid } = await projectWithSession(c)
  const dsId = await openV2(c, sid)
  setModel(st, 'scripted:b', scriptedModel(steps(
    [toolCallPart('start_run', { text: 'count the files', separate: true, model: 'scripted:a' }, 'call-separate')],
    (m: ModelMessage[]) => { expect(rec(lastToolReturn(m, 'start_run')).status).not.toBe('refused'); return modelResponse([toolCallPart('start_relay', { text: 'take turns on calc.py', agents: [{ model: 'scripted:a' }, { model: 'scripted:a' }], rounds: 1 }, 'call-relay')]) },
    [textPart('started a separate task and a relay')],
    [textPart('noted')],
  ), 'scripted-b'))
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'one task apart, and a relay' }))
  const done = await turnDone(c, turn.id)
  expect(done.status, done.error ?? '').toBe('done')
  expect(done.tool_calls.map((t) => [t.name, t.status])).toEqual([['start_run', 'ok'], ['start_relay', 'ok']])
  // the separate task: a work order of its own, asked for isolated (the core gives it its own workspace)
  const order = recorded.find((r) => r.method === 'POST' && r.path === `/api/sessions/${sid}/work-orders`)!
  expect(order.body!.workspace_policy).toBe('isolated')
  expect(rec(order.body!.work_order).prompt).toBe('count the files')
  expect(order.body!.client_request_id).toBe(nativeRequestKey(turn.id, 'call-separate'))
  expect(order.headers[DIRECTOR_SESSION_HEADER]).toBe(dsId)
  expect(order.headers[DIRECTOR_TURN_HEADER]).toBe(turn.id)
  expect(order.headers[DIRECTOR_TOOL_CALL_HEADER]).toBe('call-separate')
  expect(order.headers[TOOL_SURFACE_HEADER]).toBe('director.v2')
  // the relay: the chat route with its agents and rounds — the relay table's own chain, not a plan of steps
  const relayCall = recorded.find((r) => r.method === 'POST' && r.path === `/api/sessions/${sid}/chat`)!
  expect(relayCall.body!.agents).toEqual([{ model: 'scripted:a' }, { model: 'scripted:a' }])
  expect(relayCall.body!.rounds).toBe(1)
  expect(relayCall.headers[DIRECTOR_TOOL_CALL_HEADER]).toBe('call-relay')
  const relays = repo.listRelays(st.conn, sid)
  expect(relays).toHaveLength(1)
  expect(relays[0]!.participants).toHaveLength(2)
  expect(repo.listInteractions(st.conn, sid)).toHaveLength(0)
  // both runs are this turn's: their ends come back to it
  expect(done.dispatched_run_ids).toHaveLength(2)
  for (const id of done.dispatched_run_ids) await waitDone(st, id)
}, 60_000)

test('native v2: a session the director creates joins its reach (recorded on the director session); another project, an unrelated session, and a citation or answer of another session are refused; prose naming a run is not', async () => {
  const { c } = await recordingApp()
  const st = app!.state
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('agent answer')])))
  const { project, sid } = await projectWithSession(c, 'A')
  const other = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const b = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'B PRIVATE', model: 'scripted:a' }))
  const bRun = await json(await c.post(`/api/sessions/${b.id}/chat`, { text: 'B works' }))
  await waitDone(st, String(bRun.id))
  const aRun = await endedSeparate(c, sid, 'an A task')
  const dsId = await openV2(c, sid)
  let created = ''
  const results: Rec[] = []
  const take = (m: ModelMessage[], name: string) => { const r = rec(lastToolReturn(m, name)); results.push(r); return r }
  setModel(st, 'scripted:b', scriptedModel(steps(
    [toolCallPart('create_session', { title: 'side task' }, 'mk')],
    (m: ModelMessage[]) => { created = String(take(m, 'create_session').id); return modelResponse([toolCallPart('create_session', { project_id: other.id, title: 'elsewhere' }, 'mk-other')]) },
    (m: ModelMessage[]) => { take(m, 'create_session'); return modelResponse([toolCallPart('start_run', { session_id: created, text: 'work in the side session', model: 'scripted:a' }, 'side-run')]) },
    (m: ModelMessage[]) => { take(m, 'start_run'); return modelResponse([toolCallPart('get_session', { session_id: b.id }, 'peek-b')]) },
    (m: ModelMessage[]) => { take(m, 'get_session'); return modelResponse([toolCallPart('start_run', { text: 'see B', cites: [{ run_id: bRun.id, note: 'its table' }] }, 'cite-b')]) },
    (m: ModelMessage[]) => { take(m, 'start_run'); return modelResponse([toolCallPart('start_run', { text: 'take B', receive_run_ids: [bRun.id] }, 'recv-b')]) },
    (m: ModelMessage[]) => { take(m, 'start_run'); return modelResponse([toolCallPart('start_run', { session_id: created, text: 'take A into the side session', receive_run_ids: [aRun] }, 'recv-a-into-side')]) },
    (m: ModelMessage[]) => { take(m, 'start_run'); return modelResponse([toolCallPart('start_run', { text: `words that mention ${String(bRun.id)} only as text`, model: 'scripted:a' }, 'prose')]) },
    (m: ModelMessage[]) => { take(m, 'start_run'); return modelResponse([textPart('done')]) },
    [textPart('task events read')],
  ), 'scripted-b'))
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'set up a side session' }))
  const done = await turnDone(c, turn.id)
  expect(done.status, done.error ?? '').toBe('done')
  expect(done.tool_calls.map((t) => t.status)).toEqual(['ok', 'refused', 'ok', 'refused', 'refused', 'refused', 'refused', 'ok'])
  // the created session is in this project and recorded on the director session, not taken from any argument
  expect(repo.getSession(st.conn, created)!.project_id).toBe(String(project.id))
  expect(store.getDirectorSession(st.conn, dsId)!.config.authorized_session_ids).toEqual([created])
  expect(String(results[1]!.reason)).toContain(`only in this director's project (${String(project.id)})`)
  for (const refused of results.slice(3, 7)) {
    expect(refused.status).toBe('refused')
    expect(String(refused.reason)).toContain('outside the sessions this director reaches')
    expect(JSON.stringify(refused)).not.toContain('PRIVATE')
  }
  // nothing went into B; the side session got its run; the prose run went to A
  expect(repo.listRuns(st.conn, String(b.id)).map((r) => r.id)).toEqual([String(bRun.id)])
  const sideRuns = repo.listRuns(st.conn, created)
  expect(sideRuns).toHaveLength(1)
  expect(done.dispatched_run_ids).toContain(sideRuns[0]!.id)
  // the side run's end is told to this director (it created the session and dispatched the run)
  await waitDone(st, sideRuns[0]!.id)
  const told = await waitFor(() => store.listEvents(st.conn, dsId), (events) => events.some((e) => e.ref_id === sideRuns[0]!.id), 'the side run\'s event')
  expect(told.find((e) => e.ref_id === sideRuns[0]!.id)!.cause_turn_id).toBe(turn.id)
  for (const id of done.dispatched_run_ids) await waitDone(st, id)
  // the scope by itself: a plan's steps, an order's constraints, a reference hidden in structure, one call over two sessions
  const reach = [created]
  expect(scopeRefusal(st.conn, sid, 'schedule', { interaction_id: undefined, nodes: [{ id: 'a1', participant: 'A', cites: [String(bRun.id)] }] }, reach, 'director.v2')).toContain('outside')
  expect(scopeRefusal(st.conn, sid, 'schedule', { nodes: [{ id: 'a1', participant: 'A', receive_runs: [String(bRun.id)] }] }, reach, 'director.v2')).toContain('outside')
  expect(scopeRefusal(st.conn, sid, 'start_run', { session_id: sid, text: 'x', constraints: { extra: { deep: [String(bRun.id)] } } }, reach, 'director.v2')).toContain('outside')
  expect(scopeRefusal(st.conn, sid, 'start_run', { session_id: created, text: 'x', cites: [{ run_id: aRun }] }, reach, 'director.v2')).toContain('outside')
  expect(scopeRefusal(st.conn, sid, 'start_run', { session_id: sid, text: 'x', cites: [{ run_id: aRun, note: `see ${String(bRun.id)}` }] }, reach, 'director.v2')).toBeNull()
  expect(scopeRefusal(st.conn, sid, 'start_run', { session_id: sid, text: 'x', receive_run_ids: ['run_000000000000'] }, reach, 'director.v2'))
    .toBe(scopeRefusal(st.conn, sid, 'start_run', { session_id: sid, text: 'x', receive_run_ids: [String(bRun.id)] }, reach, 'director.v2'))    // nothing and another's: one answer
  expect(namedThings({ nodes: [{ cites: ['run_aaaaaaaaaaaa'], receive_runs: ['run_bbbbbbbbbbbb'] }], cites: [{ run_id: 'run_cccccccccccc' }], receive_run_ids: ['run_dddddddddddd'] }).map(([k, id]) => `${k}:${id}`).sort())
    .toEqual(['run:run_aaaaaaaaaaaa', 'run:run_bbbbbbbbbbbb', 'run:run_cccccccccccc', 'run:run_dddddddddddd'])
}, 60_000)

test('native v2: the original message applies only to a call that names its turn; text with it is refused; two dispatches of one turn are two requests, a reused key for another target is refused', async () => {
  const { c, recorded } = await recordingApp()
  const st = app!.state
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('agent answer')])))
  const { sid } = await projectWithSession(c)
  const ra = await endedSeparate(c, sid, 'task A')
  const rb = await endedSeparate(c, sid, 'task B')
  // integration fixture: the keyed calls name two other ended tasks (C, D) — A and B are still running the turn's first
  // two follow-ups when they come, and a participant takes one message at a time (409 participant_busy, core)
  const rc = await endedSeparate(c, sid, 'task C')
  const rd = await endedSeparate(c, sid, 'task D')
  await openV2(c, sid)
  let turnId = ''
  const outcomes: Rec[] = []
  const take = (m: ModelMessage[]) => { outcomes.push(rec(lastToolReturn(m, 'start_run'))) }
  setModel(st, 'scripted:b', scriptedModel(steps(
    (m: ModelMessage[]) => {
      // the turn the envelope line names is what source_turn_id takes
      turnId = /Original message envelope of user turn (turn_[0-9a-f]+)/.exec(userTexts(m).join('\n'))?.[1] ?? ''
      return modelResponse([toolCallPart('start_run', { resume_run_id: ra, text: 'go on with A' }, 'c-a'), toolCallPart('start_run', { resume_run_id: rb, text: 'go on with B' }, 'c-b')])
    },
    (m: ModelMessage[]) => { take(m); return modelResponse([toolCallPart('start_run', { source_turn_id: turnId, text: 'my own words too' }, 'c-both')]) },
    (m: ModelMessage[]) => { take(m); return modelResponse([toolCallPart('start_run', { resume_run_id: rc, text: 'keyed', request_id: 'same-key-0001' }, 'k1')]) },
    (m: ModelMessage[]) => { take(m); return modelResponse([toolCallPart('start_run', { resume_run_id: rd, text: 'keyed', request_id: 'same-key-0001' }, 'k2')]) },
    (m: ModelMessage[]) => { take(m); return modelResponse([toolCallPart('start_run', { resume_run_id: rc, text: 'keyed', request_id: 'same-key-0001' }, 'k3')]) },
    (m: ModelMessage[]) => { take(m); return modelResponse([toolCallPart('start_run', { source_turn_id: turnId, model: 'scripted:a' }, 'c-orig')]) },
    (m: ModelMessage[]) => { take(m); return modelResponse([textPart('sent')]) },
    [textPart('noted')],
  ), 'scripted-b'))
  const original = 'the person\'s own words, exactly'
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: original }))
  const done = await turnDone(c, turn.id)
  expect(done.status, done.error ?? '').toBe('done')
  expect(turnId).toBe(turn.id)
  // one turn, two follow-ups: two runs, each continuing the run its call named, each with its own text and key
  const followA = repo.getRun(st.conn, done.dispatched_run_ids[0]!)!
  const followB = repo.getRun(st.conn, done.dispatched_run_ids[1]!)!
  expect(new Set([followA.resumes_run_id, followB.resumes_run_id])).toEqual(new Set([ra, rb]))
  for (const run of [followA, followB]) expect(run.user_text).toBe(run.resumes_run_id === ra ? 'go on with A' : 'go on with B')
  const keys = recorded.filter((r) => r.path.endsWith('/resume')).map((r) => r.body!.client_request_id)
  expect(keys.slice(0, 2).sort()).toEqual([nativeRequestKey(turn.id, 'c-a'), nativeRequestKey(turn.id, 'c-b')].sort())
  // text beside source_turn_id: refused, nothing started
  expect(outcomes[1]!.status).toBe('error')
  expect(String(outcomes[1]!.error)).toContain('source_turn_id supplies the message')
  // one key: the first request; the same key for another target is refused; the same request again is the same run
  const keyed = String(outcomes[2]!.id)
  expect(repo.getRun(st.conn, keyed)!.resumes_run_id).toBe(rc)
  expect(String(outcomes[3]!.error)).toContain(`request_id same-key-0001 already started run ${keyed} for a different request`)
  expect(outcomes[4]!.id).toBe(keyed)
  expect(repo.listRuns(st.conn, sid).filter((r) => r.resumes_run_id === rd)).toHaveLength(0)        // D was never continued
  expect(repo.listRuns(st.conn, sid).filter((r) => r.resumes_run_id === rb)).toHaveLength(1)        // B was continued once only
  // the original message, by its turn: the person's words exactly
  const orig = repo.getRun(st.conn, String(outcomes[5]!.id))!
  expect(orig.user_text).toBe(original)
  expect(orig.resumes_run_id).toBeNull()
  // the calls without source_turn_id carried their own words, never the original's
  expect(repo.listRuns(st.conn, sid).filter((r) => r.user_text === original)).toHaveLength(1)
  for (const id of done.dispatched_run_ids) await waitDone(st, id)
}, 60_000)

test('native v1 (a pre-surface row): an original message that continues one run and a call naming another is refused, not re-targeted; separate stays refused', async () => {
  const { c } = await recordingApp()
  const st = app!.state
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('agent answer')])))
  const { sid } = await projectWithSession(c)
  const ra = await endedSeparate(c, sid, 'task A')
  const rb = await endedSeparate(c, sid, 'task B')
  setModel(st, 'scripted:b', scriptedModel(() => modelResponse([textPart('placeholder')])))
  const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b' }))
  asLegacyV1(st.conn, opened.director!.id)
  const outcomes: Rec[] = []
  setModel(st, 'scripted:b', scriptedModel(steps(
    [toolCallPart('start_run', { resume_run_id: rb, text: 'B instead' }, 'v1-b')],
    (m: ModelMessage[]) => { outcomes.push(rec(lastToolReturn(m, 'start_run'))); return modelResponse([toolCallPart('start_run', { text: 'apart', separate: true }, 'v1-sep')]) },
    (m: ModelMessage[]) => { outcomes.push(rec(lastToolReturn(m, 'start_run'))); return modelResponse([textPart('refused twice')]) },
  ), 'scripted-b'))
  const runsBefore = repo.listRuns(st.conn, sid).length
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'continue A', resumes_run_id: ra }))
  const done = await turnDone(c, turn.id)
  expect(done.status).toBe('done')
  expect(String(outcomes[0]!.error)).toContain(`continues run ${ra}; this call names run ${rb}`)
  expect(outcomes[1]!.status).toBe('refused')
  expect(repo.listRuns(st.conn, sid)).toHaveLength(runsBefore)
})

test('native v2: a final answer longer than a page is read whole from the exact run, page by page; a wait is refused', async () => {
  const { c } = await recordingApp()
  const st = app!.state
  const LONG = Array.from({ length: 14_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('') + 'END'
  let n = 0
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart(n++ === 0 ? LONG : 'a later, short answer')])))
  const { sid } = await projectWithSession(c)
  const first = await endedSeparate(c, sid, 'long answer')
  await endedSeparate(c, sid, 'short answer')                                       // a later run: never what get_run(first) reads
  await openV2(c, sid)
  const pages: Rec[] = []
  setModel(st, 'scripted:b', scriptedModel(steps(
    [toolCallPart('get_run', { run_id: first }, 'p1')],
    (m: ModelMessage[]) => { const p = rec(lastToolReturn(m, 'get_run')); pages.push(p); return modelResponse([toolCallPart('get_run', { run_id: first, cursor: p.next_cursor }, 'p2')]) },
    (m: ModelMessage[]) => { const p = rec(lastToolReturn(m, 'get_run')); pages.push(p); return modelResponse([toolCallPart('get_run', { run_id: first, cursor: p.next_cursor }, 'p3')]) },
    (m: ModelMessage[]) => { pages.push(rec(lastToolReturn(m, 'get_run'))); return modelResponse([toolCallPart('get_run', { run_id: first, wait_s: 10 }, 'wait')]) },
    (m: ModelMessage[]) => { pages.push(rec(lastToolReturn(m, 'get_run'))); return modelResponse([textPart('read')]) },
  ), 'scripted-b'))
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'read the long one' }))
  expect((await turnDone(c, turn.id)).status).toBe('done')
  expect(pages.slice(0, 3).map((p) => [String(p.final_text).length, p.next_cursor])).toEqual([[6000, '6000'], [6000, '12000'], [2003, null]])
  expect(pages.slice(0, 3).map((p) => p.final_text).join('')).toBe(LONG)
  for (const p of pages.slice(0, 3)) {
    expect(p.id).toBe(first)
    expect(p.final_text_chars).toBe(LONG.length)
    expect(p.final_text_source).toBe('receipt.final_text')
  }
  expect(pages[3]!.status).toBe('refused')
  expect(String(pages[3]!.reason)).toContain('wait_s is not available to this director')
})

test('a run\'s end is told by its recorded origin: an explicit request — a follow-up that became a step of its interaction included — is told; a plan\'s node, retry or relay turn is its group\'s', () => {
  const base = { id: 'run_aaaaaaaaaaaa', session_id: 's_1', parent_run_id: null, interaction_id: null, relay_id: null, spawned_by: 'human', work_order: null } as unknown as Run
  const withOrigin = (request: string, extra: Rec = {}) => ({ ...base, ...extra, collab: { participant_id: 'pa_0123456789abcdef', participant_role: 'member', conversation_id: null, origin: { actor: 'director', request, director_session_id: 'dir_1', director_turn_id: 'turn_1' }, placement: { surface: 'group' }, basis: 'recorded' } }) as unknown as Run
  expect(announcesRun(withOrigin('followup', { interaction_id: 'ix_1' }))).toBe(true)        // the legacy rule would drop it (interaction_id)
  for (const request of ['message', 'resume', 'separate', 'wake', 'ui_task']) expect(announcesRun(withOrigin(request)), request).toBe(true)
  for (const request of ['node', 'node_retry', 'relay_turn', 'child', 'action']) expect(announcesRun(withOrigin(request)), request).toBe(false)
  // a run from before origins: the thread rule as before
  expect(announcesRun(base)).toBe(true)
  expect(announcesRun({ ...base, interaction_id: 'ix_1' } as unknown as Run)).toBe(false)
  // v2's message names who started it and where the whole answer is read; v1's words are the baseline's
  const event = {
    id: 'ev_1', director_session_id: 'dir_1', session_id: 's_1', seq: 1, kind: 'run_finished', ref_id: 'run_aaaaaaaaaaaa', dedupe_key: 'k', cause_turn_id: 'turn_1', status: 'pending', attempts: 0,
    delivered_turn_id: null, error: null, created_at: 'x', delivered_at: null,
    payload: { run_id: 'run_aaaaaaaaaaaa', status: 'done', model: 'm', checks: {}, final_text_head: 'head', final_text_chars: 9000, collab: { participant_id: 'pa_0123456789abcdef', participant_role: 'member', origin: { actor: 'director', request: 'followup', tool_call_id: 'call_9' } }, interaction_id: 'ix_1' },
  } as unknown as DirectorOutboxEvent
  const v2 = taskEventMessage('s_1', [event], 'director.v2')
  expect(v2).toContain('started by turn turn_1 of this conversation (tool call call_9); participant pa_0123456789abcdef (member), request followup, interaction ix_1')
  expect(v2).toContain('final answer: 9000 characters, read whole with get_run run_id=run_aaaaaaaaaaaa; its first 400 characters: head')
  const v1 = taskEventMessage('s_1', [event])
  expect(v1).toStartWith('App note: Runs finished: run_aaaaaaaaaaaa.')
  expect(v1).not.toContain('participant')
  expect(v1).toContain("the agent's last words (head, its own account — judge by the receipt): head")
})

test('a native director\'s read of a run in a session it created is acknowledged to it, not to that session', async () => {
  const { c } = await recordingApp()
  const st = app!.state
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('agent answer')])))
  const { project, sid } = await projectWithSession(c)
  const dsId = await openV2(c, sid)
  const side = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'side', model: 'scripted:a' }))
  store.addAuthorizedSession(st.conn, dsId, String(side.id))
  const run = await json(await c.post(`/api/sessions/${side.id}/chat`, { text: 'side work' }))
  await waitDone(st, String(run.id))
  store.enqueueEvent(st.conn, { director_session_id: dsId, session_id: String(side.id), kind: 'run_finished', ref_id: String(run.id), dedupe_key: `run_finished:${String(run.id)}`, cause_turn_id: null, payload: {} })
  expect(st.director.acknowledgeRun(String(run.id))).toBe(false)                    // the side session has no director of its own
  expect(st.director.acknowledgeRun(String(run.id), dsId)).toBe(true)                // the director that read it
  expect(store.listEvents(st.conn, dsId).find((e) => e.ref_id === run.id)!.status).toBe('delivered')
})

// ---- the connector, against a recorded harness ------------------------------------------------------------------

interface MockCall { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: Rec | null }
function mockHarness(routes: (call: MockCall) => unknown): { harness: Harness; calls: MockCall[] } {
  const calls: MockCall[] = []
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Rec) : null
    const call = { method: init?.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body }
    calls.push(call)
    const out = routes(call)
    if (out instanceof Response) return out
    if (out === undefined) return new Response(JSON.stringify({ detail: `no mock for ${call.method} ${call.path}` }), { status: 404 })
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { harness: Harness.connect('http://harness.mock', 'tok', { fetchImpl }), calls }
}

async function connect(harness: Harness, surface: 'director.v1' | 'director.v2'): Promise<McpClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildServer(harness.as('ChatGPT'), { surface }).connect(serverSide)
  const client = new McpClient({ name: 't', version: '0' })
  await client.connect(clientSide)
  return client
}
async function call(client: McpClient, name: string, args: Rec): Promise<Rec> {
  const result = await client.callTool({ name, arguments: args })
  const text = ((result.content as { text?: string }[] | undefined) ?? []).map((p) => p.text ?? '').join('')
  if (result.isError) return { error: text }
  return (result.structuredContent as Rec | undefined) ?? (JSON.parse(text) as Rec)
}

const RUN = (id: string, extra: Rec = {}) => ({ id, session_id: 's_aaaaaaaaaaaa', status: 'running', user_text: 'x', resumes_run_id: null, ...extra })
const standard = (call: MockCall): unknown => {
  if (call.path === '/api/director/waiting') return { waiting: [] }
  if (call.method === 'GET' && call.path === '/api/runs/run_bbbbbbbbbbbb') return RUN('run_bbbbbbbbbbbb', { session_id: 's_bbbbbbbbbbbb', status: 'done' })
  if (call.method === 'GET' && call.path === '/api/runs/run_aaaaaaaaaaaa') return RUN('run_aaaaaaaaaaaa', { status: 'done' })
  if (call.method === 'POST' && call.path === '/api/sessions/s_aaaaaaaaaaaa/chat') return RUN('run_cccccccccccc', { user_text: call.body!.text, ...(Array.isArray(call.body!.agents) && call.body!.agents.length > 1 ? { relay_id: 'relay_000000000001' } : {}) })
  if (call.method === 'GET' && call.path === '/api/relays/relay_000000000001') return { id: 'relay_000000000001', status: 'running', rounds: 1, round: 1, current_step: 0, participants: [{ id: 'A', model: 'm:a', label: 'A' }, { id: 'B', model: 'm:a', label: 'B' }] }
  if (call.method === 'POST' && call.path === '/api/sessions/s_aaaaaaaaaaaa/interactions') return { id: 'ix_000000000001', status: 'planning', nodes: [] }
  return undefined
}

test('connector, both surfaces: a follow-up of another session\'s run under a named session, and a separate task carrying a follow-up in its constraints, are refused before anything starts', async () => {
  for (const surface of ['director.v1', 'director.v2'] as const) {
    const { harness, calls } = mockHarness(standard)
    mcp = await connect(harness, surface)
    const misdirected = await call(mcp, 'start_run', { session_id: 's_aaaaaaaaaaaa', text: 'go on', resume_run_id: 'run_bbbbbbbbbbbb' })
    expect(String(misdirected.error), surface).toContain('resume_run_id run_bbbbbbbbbbbb is not a run of session s_aaaaaaaaaaaa')
    const smuggled = await call(mcp, 'start_run', { session_id: 's_aaaaaaaaaaaa', text: 'apart', separate: true, constraints: { resumes_run_id: 'run_aaaaaaaaaaaa' } })
    expect(String(smuggled.error), surface).toContain('constraints cannot name resumes_run_id')
    expect(calls.filter((c) => c.method === 'POST'), surface).toEqual([])
    // every request names the surface it came through, and no director call (a connector holds no director turn)
    for (const c of calls) {
      expect(c.headers[TOOL_SURFACE_HEADER]).toBe(surface)
      expect(c.headers[DIRECTOR_SESSION_HEADER]).toBeUndefined()
      expect(c.headers['x-oasis-code-connector']).toBe('ChatGPT')
    }
    await mcp.close()
    mcp = null
  }
})

test('connector v2: citations and handed-over answers reach the API as the contract names them; v1 drops them as its schema always did', async () => {
  const { harness, calls } = mockHarness(standard)
  mcp = await connect(harness, 'director.v2')
  const cites = [{ run_id: 'run_aaaaaaaaaaaa', note: 'its table' }]
  const ok = await call(mcp, 'start_run', { session_id: 's_aaaaaaaaaaaa', text: 'compare', cites, receive_run_ids: ['run_aaaaaaaaaaaa'] })
  expect(ok.id).toBe('run_cccccccccccc')
  const chat = calls.find((c) => c.method === 'POST' && c.path.endsWith('/chat'))!
  expect(chat.body!.cites).toEqual(cites)
  expect(chat.body!.receive_run_ids).toEqual(['run_aaaaaaaaaaaa'])
  // a name instead of an exact run is no run id
  expect(String((await call(mcp, 'start_run', { session_id: 's_aaaaaaaaaaaa', text: 'x', cites: [{ run_id: 'latest' }] })).error)).toContain('run id')
  expect(String((await call(mcp, 'start_run', { session_id: 's_aaaaaaaaaaaa' })).error)).toContain('text is required unless source_turn_id is given')
  await mcp.close()
  const v1 = mockHarness(standard)
  mcp = await connect(v1.harness, 'director.v1')
  await call(mcp, 'start_run', { session_id: 's_aaaaaaaaaaaa', text: 'compare', cites, receive_run_ids: ['run_aaaaaaaaaaaa'] })
  const v1chat = v1.calls.find((c) => c.method === 'POST' && c.path.endsWith('/chat'))!
  expect(v1chat.body!.cites).toBeUndefined()
  expect(v1chat.body!.receive_run_ids).toBeUndefined()
})

test('connector: v1 binds the waiting user turn\'s original message implicitly (as v1 promised); v2 only where a call names the turn, and a v2 separate task may carry it', async () => {
  const envelope = { text: 'ORIGINAL WORDS', attachments: [], mentions: [], fresh: false, participant_thinking: {} }
  const routes = (c: MockCall): unknown => {
    if (c.path === '/api/director/waiting') return { waiting: [{ session_id: 's_aaaaaaaaaaaa', title: 't', project_id: 'p_1', turn_id: 'turn_000000000001', turn_kind: 'user' }] }
    if (c.path === '/api/director-turns/turn_000000000001') return { id: 'turn_000000000001', session_id: 's_aaaaaaaaaaaa', kind: 'user', envelope }
    if (c.method === 'POST' && c.path === '/api/sessions/s_aaaaaaaaaaaa/work-orders') return RUN('run_dddddddddddd', { work_order: c.body!.work_order })
    return standard(c)
  }
  const v1 = mockHarness(routes)
  mcp = await connect(v1.harness, 'director.v1')
  await call(mcp, 'start_run', { text: 'paraphrase' })
  expect(v1.calls.find((c) => c.path.endsWith('/chat'))!.body!.text).toBe('ORIGINAL WORDS')
  expect(v1.calls.find((c) => c.path.endsWith('/chat'))!.body!.client_request_id).toBeUndefined()   // no key made up for it
  await mcp.close()
  const v2 = mockHarness(routes)
  mcp = await connect(v2.harness, 'director.v2')
  await call(mcp, 'start_run', { text: 'my own words' })
  expect(v2.calls.find((c) => c.path.endsWith('/chat'))!.body!.text).toBe('my own words')
  expect(v2.calls.some((c) => c.path.startsWith('/api/director-turns/'))).toBe(false)
  const apart = await call(mcp, 'start_run', { source_turn_id: 'turn_000000000001', separate: true })
  expect(apart.id).toBe('run_dddddddddddd')
  const order = v2.calls.find((c) => c.path.endsWith('/work-orders'))!.body!
  expect(rec(order.work_order).prompt).toBe('ORIGINAL WORDS')
  expect(order.workspace_policy).toBe('isolated')
})

test('connector v2: start_relay is the chat route\'s relay; start_interaction plans by mode, by the director, or by the steps given', async () => {
  const { harness, calls } = mockHarness(standard)
  mcp = await connect(harness, 'director.v2')
  const relay = await call(mcp, 'start_relay', { session_id: 's_aaaaaaaaaaaa', text: 'take turns', agents: [{ model: 'm:a' }, { model: 'm:a' }], rounds: 2 })
  expect(relay.relay_id).toBe('relay_000000000001')
  expect(rec(relay.relay).participants).toHaveLength(2)
  const body = calls.find((c) => c.path.endsWith('/chat'))!.body!
  expect(body.agents).toEqual([{ model: 'm:a' }, { model: 'm:a' }])
  expect(body.rounds).toBe(2)
  const participants = [{ model: 'm:a', id: 'pa' }, { model: 'm:b', id: 'pb' }]
  await call(mcp, 'start_interaction', { session_id: 's_aaaaaaaaaaaa', text: 'plan it', participants, mode: 'director' })
  await call(mcp, 'start_interaction', { session_id: 's_aaaaaaaaaaaa', text: 'these steps', participants, nodes: [{ id: 'a1', participant: 'pa' }, { id: 'b1', participant: 'pb', depends_on: ['a1'], receives: ['a1'], cites: ['run_aaaaaaaaaaaa'] }], then: 'director' })
  await call(mcp, 'start_interaction', { session_id: 's_aaaaaaaaaaaa', text: 'two at once', participants, mode: 'discussion', cross_rounds: 2 })
  const bodies = calls.filter((c) => c.path.endsWith('/interactions')).map((c) => c.body!)
  expect(bodies.map((b) => b.plan)).toEqual([
    null,
    { nodes: [{ id: 'a1', participant: 'pa', depends_on: [], receives: [], workspace: 'own' }, { id: 'b1', participant: 'pb', depends_on: ['a1'], receives: ['a1'], workspace: 'own', cites: ['run_aaaaaaaaaaaa'] }], then: 'director' },
    { template: 'discussion', cross_rounds: 2 },
  ])
  for (const b of bodies) expect(b.workspace_policy).toBe('isolated')
  expect(String((await call(mcp, 'start_interaction', { session_id: 's_aaaaaaaaaaaa', text: 'both', participants, mode: 'independent', nodes: [{ id: 'a1', participant: 'pa' }] })).error)).toContain('mode and nodes cannot be combined')
})

test('connector v2: get_collaboration reads a session\'s record a page at a time, a run\'s edges and a participant\'s runs; get_run carries the run\'s edges', async () => {
  const edges = Array.from({ length: 120 }, (_, i) => ({ id: `eg_${i}`, kind: i % 2 ? 'cited' : 'received', from: { kind: 'run', id: 'run_aaaaaaaaaaaa' }, to: { kind: 'run', id: 'run_cccccccccccc' }, basis: 'recorded', meta: {} }))
  const { harness, calls } = mockHarness((c) => {
    if (c.path === '/api/sessions/s_aaaaaaaaaaaa/collaboration') return { session_id: 's_aaaaaaaaaaaa', revision: 'r7', main_participant_id: 'pa_0000000000000001', actors: [{ kind: 'person' }], participants: [{ id: 'pa_0000000000000001', role: 'main' }], conversations: [], groups: [], runs: [], nodes: [], edges, thread_items: [], legacy: { projected_runs: 0, inferred_facts: 0, notes: [] } }
    if (c.path === '/api/runs/run_aaaaaaaaaaaa/collaboration') return { run: { id: 'run_aaaaaaaaaaaa', session_id: 's_aaaaaaaaaaaa' }, participant: null, conversation: null, incoming: [], outgoing: edges.slice(0, 3), related_runs: [] }
    if (c.path === '/api/participants/pa_0000000000000001') return { participant: { id: 'pa_0000000000000001', session_id: 's_aaaaaaaaaaaa', role: 'main' }, runs: [{ id: 'run_aaaaaaaaaaaa' }], next_before: 'run_000000000000' }
    if (c.path === '/api/runs/run_aaaaaaaaaaaa') return RUN('run_aaaaaaaaaaaa', { status: 'done', receipt: { final_text: 'the answer' }, collab: { participant_id: 'pa_0000000000000001', participant_role: 'main', origin: { actor: 'person', request: 'message' } } })
    if (c.path === '/api/runs/run_aaaaaaaaaaaa/director-ack') return { acknowledged: false }
    return standard(c)
  })
  mcp = await connect(harness, 'director.v2')
  const page1 = await call(mcp, 'get_collaboration', { session_id: 's_aaaaaaaaaaaa' })
  expect(page1.edges as unknown[]).toHaveLength(50)
  expect(page1.edges_total).toBe(120)
  expect(page1.next_cursor).toBe('50')
  const page3 = await call(mcp, 'get_collaboration', { session_id: 's_aaaaaaaaaaaa', cursor: '100' })
  expect(page3.edges as unknown[]).toHaveLength(20)
  expect(page3.next_cursor).toBeNull()
  const runEdges = await call(mcp, 'get_collaboration', { run_id: 'run_aaaaaaaaaaaa' })
  expect(runEdges.outgoing as unknown[]).toHaveLength(3)
  const participant = await call(mcp, 'get_collaboration', { participant_id: 'pa_0000000000000001', limit: 10 })
  expect(participant.session_id).toBe('s_aaaaaaaaaaaa')
  expect(participant.next_cursor).toBe('run_000000000000')
  expect(calls.find((c) => c.path === '/api/participants/pa_0000000000000001')!.query).toEqual({ limit: '10' })
  const run = await call(mcp, 'get_run', { run_id: 'run_aaaaaaaaaaaa' })
  expect(run.final_text).toBe('the answer')
  expect(run.final_text_source).toBe('receipt.final_text')
  expect(rec(run.collab).participant_role).toBe('main')
  expect(rec(run.edges).outgoing_total).toBe(3)
})

test('a harness copy for one call carries that call\'s headers only: calls side by side never take each other\'s', async () => {
  const seen: Record<string, string>[] = []
  const base = Harness.connect('http://harness.mock', 'tok', { fetchImpl: async (_input, init) => { await sleep(Math.random() * 10); seen.push({ ...(init!.headers as Record<string, string>) }); return new Response('{}') } })
  await Promise.all(Array.from({ length: 12 }, (_, i) => base.with({ director_session_id: `dir_${i}`, turn_id: `turn_${i}`, tool_call_id: `call_${i}`, surface: 'director.v2' }).get('/api/x')))
  await base.get('/api/x')
  expect(seen).toHaveLength(13)
  for (const h of seen.slice(0, 12)) {
    const i = String(h[DIRECTOR_SESSION_HEADER]).slice(4)
    expect(h[DIRECTOR_TURN_HEADER]).toBe(`turn_${i}`)
    expect(h[DIRECTOR_TOOL_CALL_HEADER]).toBe(`call_${i}`)
  }
  expect(seen[12]![DIRECTOR_SESSION_HEADER]).toBeUndefined()                         // the original was never changed
  expect(base.context).toBeNull()
})

// ---- native v3 -----------------------------------------------------------------------------------------------------

test("native v3: steer_run hands words to a separate task while it works — at its next request, after a line that says they are the director's", async () => {
  const { c, recorded } = await recordingApp()
  const st = app!.state
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let entered!: () => void
  const working = new Promise<void>((r) => { entered = r })
  const seen: ModelMessage[][] = []
  setModel(st, 'scripted:a', scriptedModel(async (messages: ModelMessage[]) => {
    seen.push(messages)
    if (seen.length === 1) { entered(); await held; return modelResponse([textPart('first answer')]) }
    return modelResponse([textPart('second answer, kept short')])
  }, 'scripted-a'))
  const { sid } = await projectWithSession(c)
  const task = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'explain calc.py', model: 'scripted:a' } }))
  await working
  if (!st.model_overrides.has('scripted:b')) setModel(st, 'scripted:b', scriptedModel(() => modelResponse([textPart('placeholder')])))
  const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: 'scripted:b', config: { allow_destructive: false } }))
  expect(opened.director!.tool_surface).toBe(CURRENT_DIRECTOR_TOOL_SURFACE)    // a new director session holds the current surface
  setModel(st, 'scripted:b', scriptedModel(steps(
    [toolCallPart('steer_run', { run_id: String(task.id), text: 'keep it short' }, 'call-steer')],
    (m: ModelMessage[]) => { expect(rec(lastToolReturn(m, 'steer_run')).status).not.toBe('refused'); return modelResponse([textPart('told it')]) },
    [textPart('noted')],
  ), 'scripted-b'))
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'tell the task to keep it short' }))
  const done = await turnDone(c, turn.id)
  expect(done.status, done.error ?? '').toBe('done')
  expect(done.tool_calls.map((t) => [t.name, t.status])).toEqual([['steer_run', 'ok']])
  // the call went to the run's steer route as the director's call
  const call = recorded.find((r) => r.method === 'POST' && r.path === `/api/runs/${task.id}/steer`)!
  expect(call.body!.text).toBe('keep it short')
  expect(call.body!.client_request_id).toBe(nativeRequestKey(turn.id, 'call-steer'))
  expect(call.headers[TOOL_SURFACE_HEADER]).toBe(CURRENT_DIRECTOR_TOOL_SURFACE)
  release()
  expect((await waitDone(st, String(task.id))).status).toBe('done')
  expect(st.runs.steersOf(String(task.id)).map((s) => [s.text, s.status, s.by])).toEqual([['keep it short', 'delivered', 'director']])
  const last = seen[1]!.at(-1) as { parts: { content: unknown }[] }
  expect(last.parts.map((p) => p.content).slice(-2)).toEqual(['App note: The director sent what follows while you were working. It came after everything above.', 'keep it short'])
}, 60_000)
