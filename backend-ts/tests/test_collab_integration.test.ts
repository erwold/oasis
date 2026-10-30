/** The integration of the collaboration model's three tracks (core, director, page) — what each track left to the
 *  others, exercised through the real app: the HTTP API, the native director transport over the in-memory MCP server,
 *  the runner and the scheduler. Scripted models only; the suite's preload refuses every non-loopback host.
 *
 *  - a member's follow-up queued behind its group (HTTP 202): its shape, its key, the run it becomes (the same
 *    participant), a director's call that gets it and is woken by that run's end through its recorded origin;
 *  - director-ack and the planning texts read through the director's own surface;
 *  - a relay's first turn handed the exact runs a message names (and nothing broadcast to later turns);
 *  - pre-v12 child runs continued as the same child, under their order (inherited or narrowed), or none;
 *  - one key, one intent: a first thread message, an interaction. */

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CURRENT_DIRECTOR_TOOL_SURFACE, type CollaborationGraph, type DirectorDetail, type DirectorTurn } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { CONNECTOR_HEADER } from '../src/api/auth.ts'
import * as store from '../src/director/store.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import {
  AGENT, attempt, buildLegacyV24, chat, collabOf, ended, graphOf, insertRunLike, legacyAnswer, openSnapshot, OTHER, PA, PB, PC, Recorder, until,
  type Row,
} from './collaboration_acceptance_helpers.ts'
import { asLegacyV1, onSurface } from './director_surface_fixtures.ts'
import { scriptedModel, setModel, testSettings } from './harness.ts'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const SLOW = 'scripted:c'
const DIRECTOR = 'scripted:d'

let app: App | null = null
let release: () => void = () => {}
afterEach(async () => { release(); release = () => {}; if (app) await app.close(); app = null })

/** A group of three on the independent template, two at a time: A answers at once, B and C wait on the gate — so once A
 *  ended, the group runs with its two places taken and a follow-up of A has to wait in its queue. */
async function busyGroup(c: Client, sid: string): Promise<{ ix: string; a1: string; pidA: string }> {
  const gate = new Promise<void>((r) => { release = r })
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('A answer')])))
  setModel(app!.state, SLOW, scriptedModel(async () => { await gate; return modelResponse([textPart('slow answer')]) }))
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, {
    text: 'each of you, alone', participants: [{ model: AGENT, id: PA }, { model: SLOW, id: PB }, { model: SLOW, id: PC }], plan: { template: 'independent' }, concurrency: 2,
  }))
  const ixId = String(ix.id)
  const nodes = await until(() => repo.listNodes(app!.state.conn, ixId), (ns) => {
    const a = ns.find((n) => n.participant === PA)
    return a?.status === 'done' && ns.filter((n) => n.status === 'running').length === 2
  }, 'A done, B and C running')
  const a1 = nodes.find((n) => n.participant === PA)!.run_id!
  const g = await graphOf(c, sid)
  const pidA = g.runs.find((r) => r.id === a1)!.collab.participant_id!
  return { ix: ixId, a1, pidA }
}

test('a member\'s follow-up its group cannot start yet is a 202 with the step (no run id); the key holds that step; the run it becomes is the same participant\'s', async () => {
  app = await makeApp()
  const { c, sid } = await openSnapshot(app)
  const { ix, a1, pidA } = await busyGroup(c, sid)
  const key = 'queued-followup-key-0001'
  const first = await c.post(`/api/participants/${pidA}/messages`, { text: 'one more pass, A', client_request_id: key, expected_head_run_id: a1 })
  expect(first.status).toBe(202)
  const queued = await first.json() as Rec
  expect(queued).toEqual({ queued: true, interaction_id: ix, node_id: 'fu-1', participant_id: pidA })
  expect(queued.id).toBeUndefined()
  // the same send again: the same step, nothing added
  const again = await c.post(`/api/participants/${pidA}/messages`, { text: 'one more pass, A', client_request_id: key, expected_head_run_id: a1 })
  expect(again.status).toBe(202)
  expect(await again.json()).toEqual(queued)
  expect(repo.listNodes(app.state.conn, ix).filter((n) => n.kind === 'followup')).toHaveLength(1)
  // the key is that step's: another request under it is refused, whatever route
  const other = await attempt(c, `/api/participants/${pidA}/messages`, { text: 'other words', client_request_id: key, expected_head_run_id: a1 })
  expect(other.status).toBe(409)
  expect(other.body.code).toBe('key_conflict')
  const viaChat = await attempt(c, `/api/sessions/${sid}/chat`, { text: 'a thread message', client_request_id: key })
  expect(viaChat.status).toBe(409)
  expect(viaChat.body.code).toBe('key_conflict')
  const viaOrder = await attempt(c, `/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'an order' }, client_request_id: key })
  expect(viaOrder.status).toBe(409)
  // the queue reaches it: its run is A's next one — the step's id, the participant, the conversation continued
  release()
  const node = await until(() => repo.getNode(app!.state.conn, ix, 'fu-1')!, (n) => n.run_id !== null, 'the step to start')
  const run = await ended(c, node.run_id!)
  expect(run.interaction_id).toBe(ix)
  expect(run.interaction_node).toBe('fu-1')
  expect(run.resumes_run_id).toBe(a1)
  expect(collabOf(run).participant_id).toBe(pidA)
  expect(collabOf(run).conversation_id).toBe(collabOf(await json(await c.get(`/api/runs/${a1}`))).conversation_id)
  expect(collabOf(run).origin).toMatchObject({ actor: 'person', request: 'followup' })
  // the key again, now that the step has its run: that run (200)
  const resent = await c.post(`/api/participants/${pidA}/messages`, { text: 'one more pass, A', client_request_id: key, expected_head_run_id: a1 })
  expect(resent.status).toBe(200)
  expect((await resent.json() as Rec).id).toBe(run.id)
}, 90_000)

test('native director v2: start_run of a busy group\'s member answers the queued step; the step\'s run carries the call\'s origin, joins the turn\'s dispatches, and its end wakes the director through that origin', async () => {
  app = await makeApp()
  const st = app.state
  const { c, sid } = await openSnapshot(app)
  const { ix, a1, pidA } = await busyGroup(c, sid)
  setModel(st, DIRECTOR, scriptedModel(() => modelResponse([textPart('placeholder')])))
  const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: DIRECTOR, config: { allow_destructive: false } }))
  const dsId = opened.director!.id
  // a new session opens on the newest surface; this test pins director.v2's behaviour on a v2 conversation
  expect(opened.director!.tool_surface).toBe(CURRENT_DIRECTOR_TOOL_SURFACE)
  onSurface(app!.state.conn, dsId, 'director.v2')
  let returned: Rec | null = null
  let calls = 0
  setModel(st, DIRECTOR, scriptedModel((m: ModelMessage[]) => {
    calls += 1
    if (calls === 1) return modelResponse([toolCallPart('start_run', { resume_run_id: a1, text: 'go on, A' }, 'call-follow-a')])
    if (calls === 2) { returned = rec(lastToolReturn(m, 'start_run')); return modelResponse([textPart('A is queued')]) }
    return modelResponse([textPart('noted')])
  }))
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'ask A for one more pass' }))
  const done = await until(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${turn.id}`)), (t) => ['done', 'error', 'cancelled'].includes(t.status), 'the turn')
  expect(done.status, done.error ?? '').toBe('done')
  expect(returned).toMatchObject({ status: 'queued', queued: true, run_id: null, interaction_id: ix, node_id: 'fu-1', participant_id: pidA, resumes_run_id: a1 })
  expect(done.dispatched_run_ids).toEqual([])                                             // nothing named that does not exist
  // the step runs once the group frees a place: the director's call is its origin, and the turn's dispatch
  release()
  const node = await until(() => repo.getNode(st.conn, ix, 'fu-1')!, (n) => n.run_id !== null, 'the step to start')
  const run = await ended(c, node.run_id!)
  expect(collabOf(run).participant_id).toBe(pidA)
  expect(collabOf(run).origin).toMatchObject({ actor: 'director', request: 'followup', director_session_id: dsId, director_turn_id: turn.id, tool_call_id: 'call-follow-a', basis: 'recorded' })
  expect(store.getTurn(st.conn, turn.id)!.dispatched_run_ids).toContain(String(run.id))
  // the end is told to that director, caused by that turn (repo.getRun alone has no collab: the origin is read for it)
  const event = await until(() => store.listEvents(st.conn, dsId).find((e) => e.kind === 'run_finished' && e.ref_id === run.id) ?? null, (e) => e !== null, 'the run_finished event')
  expect(event!.cause_turn_id).toBe(turn.id)
  await until(() => store.listTurns(st.conn, dsId).find((t) => t.event_ids.includes(event!.id)) ?? null, (t) => t !== null, 'a turn delivering it')
  // the graph: the director turn dispatched it (a recorded edge)
  const g: CollaborationGraph = await graphOf(c, sid)
  expect(g.edges.some((e) => e.kind === 'dispatched' && e.from.id === turn.id && e.to.id === run.id)).toBe(true)
}, 90_000)

test('director-ack reads the director whose checked headers name it; a context that does not check out is refused, never read as another director\'s', async () => {
  app = await makeApp()
  const st = app.state
  const { c, sid, pid } = await openSnapshot(app)
  setModel(st, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  setModel(st, DIRECTOR, scriptedModel(() => modelResponse([textPart('noted')])))
  const run = await chat(c, sid, { text: 'hello' })
  const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: DIRECTOR, config: {} }))
  const dsId = opened.director!.id
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${sid}/director/messages`, { text: 'hi' }))
  await until(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${turn.id}`)), (t) => t.status === 'done', 'the turn')
  const ack = (headers: Record<string, string>) => c.post(`/api/runs/${run.id}/director-ack`, {}, headers)
  expect((await ack({ 'x-oasis-director-session-id': dsId, 'x-oasis-director-turn-id': 'turn_000000000000' })).status).toBe(400)
  // a director of another session that was never given this one
  const other = await openSessionOf2(c, pid)
  const otherDs = await json<DirectorDetail>(await c.post(`/api/sessions/${other}/director`, { transport: 'native', model: DIRECTOR, config: {} }))
  const otherTurn = await json<DirectorTurn>(await c.post(`/api/sessions/${other}/director/messages`, { text: 'hi' }))
  await until(async () => json<DirectorTurn>(await c.get(`/api/director-turns/${otherTurn.id}`)), (t) => t.status === 'done', 'the other turn')
  expect((await ack({ 'x-oasis-director-session-id': otherDs.director!.id, 'x-oasis-director-turn-id': otherTurn.id })).status).toBe(403)
  const okay = await ack({ 'x-oasis-director-session-id': dsId, 'x-oasis-director-turn-id': turn.id })
  expect(okay.status).toBe(200)
  expect((await okay.json() as Rec).run_id).toBe(run.id)
}, 60_000)

async function openSessionOf2(c: Client, pid: string): Promise<string> {
  return String((await json(await c.post(`/api/projects/${pid}/sessions`, { title: 'other', model: AGENT }))).id)
}

test('an interaction the director plans is asked in the words of the director\'s own surface: v2\'s for a v2 director, v1\'s byte for byte for a v1 one', async () => {
  for (const surface of ['director.v2', 'director.v1'] as const) {
    app = await makeApp()
    const st = app.state
    const { c, sid } = await openSnapshot(app)
    setModel(st, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
    setModel(st, DIRECTOR, scriptedModel(() => modelResponse([textPart('no plan from me')])))
    const opened = await json<DirectorDetail>(await c.post(`/api/sessions/${sid}/director`, { transport: 'native', model: DIRECTOR, config: {} }))
    if (surface === 'director.v1') asLegacyV1(st.conn, opened.director!.id)
    const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'plan this', participants: [{ model: AGENT }, { model: AGENT }] }))
    const turnId = await until(() => repo.getInteraction(st.conn, String(ix.id))!.director_turn_id, (t) => t !== null, 'the planning turn')
    const input = store.getTurn(st.conn, turnId!)!.input
    if (surface === 'director.v2') {
      expect(input.startsWith(`App note: Interaction ${String(ix.id)} has no plan yet.`)).toBe(true)
      expect(input).not.toContain('You are its router')
    } else {
      expect(input.startsWith(`App note: Plan interaction ${String(ix.id)}.`)).toBe(true)
    }
    await until(() => repo.getInteraction(st.conn, String(ix.id))!.status, (s) => s !== 'planning', 'the plan turn to end')
    await app.close()
    app = null
  }
}, 90_000)

test('a relay hands its first turn the exact runs the message names — a cited one by its id, a received one whole — records the edges to that turn, and broadcasts nothing of them to the later turns', async () => {
  app = await makeApp()
  const rec2 = new Recorder()
  const long = `X-WHOLE-ANSWER ${'x'.repeat(9_500)} X-END`
  rec2.install(app, AGENT, (s) => (s.last.includes('MAKE-X') ? long : s.last.includes('MAKE-Y') ? 'Y-PRIVATE-ANSWER' : 'relay turn answer'))
  const { c, sid } = await openSnapshot(app)
  const x = await chat(c, sid, { text: 'MAKE-X' })
  const y = await chat(c, sid, { text: 'MAKE-Y' })
  // refused before anything starts: a run of another session
  const { sid: other } = await openSnapshot(app, 'other')
  const foreign = await chat(c, other, { text: 'MAKE-FOREIGN' })
  const relaysBefore = repo.listRelays(app.state.conn, sid).length
  const refused = await attempt(c, `/api/sessions/${sid}/chat`, { text: 'RELAY-REFUSED', agents: [{ model: AGENT }, { model: AGENT }], receive_run_ids: [foreign.id] })
  expect(refused.status).toBe(400)
  expect(repo.listRelays(app.state.conn, sid).length).toBe(relaysBefore)
  // the relay: fresh (no thread history), the first turn handed X whole and told of Y
  const first = await json(await c.post(`/api/sessions/${sid}/chat`, {
    text: 'RELAY-OVER-THESE', agents: [{ model: AGENT }, { model: AGENT }], fresh: true, cites: [{ run_id: y.id, note: 'its list' }], receive_run_ids: [x.id],
  }))
  const turns = await until(() => app!.state.conn.all('SELECT id, status FROM runs WHERE session_id=? AND relay_id IS NOT NULL ORDER BY relay_step', [sid]), (rows) => rows.length === 2 && rows.every((r) => r.status === 'done'), 'the relay to end')
  expect(turns[0]!.id).toBe(first.id)
  const relayRequests = rec2.seen.filter((s) => s.text.includes('RELAY-OVER-THESE'))
  const [t1, t2] = [String(turns[0]!.id), String(turns[1]!.id)]
  const firstReq = relayRequests.filter((s) => s.text.includes(long))
  expect(firstReq.length).toBeGreaterThanOrEqual(1)                                          // the whole answer, uncut
  expect(firstReq[0]!.text).toContain(String(y.id))                                          // Y named by its run
  for (const s of rec2.seen) expect(s.text).not.toContain('Y-PRIVATE-ANSWER')                 // Y's content handed to no one
  // the second turn: the first turn's answer (the relay's own flow), nothing of X or of Y's id
  const later = relayRequests.filter((s) => !s.text.includes(long))
  expect(later.length).toBeGreaterThanOrEqual(1)
  for (const s of later) { expect(s.text).not.toContain('X-WHOLE-ANSWER'); expect(s.text).not.toContain(String(y.id)) }
  const g = await graphOf(c, sid)
  const received = g.edges.filter((e) => e.kind === 'received' && e.from.id === x.id)
  expect(received.map((e) => e.to.id)).toEqual([t1])
  expect(received[0]!.meta).toMatchObject({ via: 'dispatch', packet: 'whole', answer_chars: Array.from(long).length, handed_chars: Array.from(long).length, content_delivered: true })
  const cited = g.edges.filter((e) => e.kind === 'cited' && e.from.id === y.id)
  expect(cited.map((e) => e.to.id)).toEqual([t1])
  expect(cited[0]!.meta).toMatchObject({ content_delivered: false, note: 'its list', by: 'person' })
  expect(g.edges.some((e) => (e.kind === 'received' || e.kind === 'cited') && e.to.id === t2 && (e.from.id === x.id || e.from.id === y.id))).toBe(false)
}, 90_000)

test('pre-v12 child runs go on as the same child: under the order they carried (inherited, narrowed, never widened) or, without one, with no order — on their card, with their own tool list; a thread message cannot take them over', async () => {
  const settings = testSettings()
  const L = await buildLegacyV24(settings)
  const { sid } = L
  const { child, t1 } = L.ids
  // a second child of the same tree that ran under no order (the v24 row copied, its order left out)
  const db = new Database(settings.db_path)
  const childRow = db.query('SELECT * FROM runs WHERE id=?').get(child) as Row
  insertRunLike(db, childRow, { id: 'run_legacychild000002', work_order_json: null, user_text: 'LEGACY-CHILD-2', created_at: new Date(Date.parse(String(childRow.created_at)) + 1).toISOString(), finished_at: new Date(Date.parse(String(childRow.finished_at)) + 1).toISOString() }, true)
  db.close()
  app = await makeApp(settings)
  const rec2 = new Recorder()
  rec2.install(app, AGENT, legacyAnswer)
  rec2.install(app, OTHER, legacyAnswer)
  const c = new Client(app)
  const g0 = await graphOf(c, sid)
  const proj = g0.runs.find((r) => r.id === child)!.collab
  expect(proj.participant_role).toBe('child')
  expect(proj.basis).not.toBe('recorded')
  // a thread message naming it: refused, nothing started
  const before = repo.listRuns(app.state.conn, sid).length
  expect((await attempt(c, `/api/sessions/${sid}/chat`, { text: 'TAKE-OVER', resumes_run_id: child })).status).toBe(400)
  // widening its order: refused
  expect((await attempt(c, `/api/runs/${child}/resume`, { text: 'WIDEN', work_order: { read_only: false } })).status).toBe(400)
  expect((await attempt(c, `/api/runs/${child}/resume`, { text: 'WIDEN', work_order: { tools: ['read_file', 'bash'] } })).status).toBe(400)
  expect(repo.listRuns(app.state.conn, sid).length).toBe(before)
  // inherited: the same child, its card under the parent, its order, the tools of its record
  const r1 = await ended(c, String((await json(await c.post(`/api/runs/${child}/resume`, { text: 'CHILD-FOLLOWUP-1' }))).id))
  expect(r1.status).toBe('done')
  expect(collabOf(r1)).toMatchObject({ participant_id: proj.participant_id, participant_role: 'child', conversation_id: proj.conversation_id, placement: { surface: 'card', anchor: { kind: 'run', id: t1 } } })
  expect((r1.work_order as Rec).read_only).toBe(true)
  expect(rec2.one('CHILD-FOLLOWUP-1').tools).toEqual(['read_file'])
  // narrowed (the same tools, fewer limits widened: none) — and again from there, the same conversation
  const r2 = await ended(c, String((await json(await c.post(`/api/runs/${r1.id}/resume`, { text: 'CHILD-FOLLOWUP-2', work_order: { tools: ['read_file'] } }))).id))
  expect(collabOf(r2)).toMatchObject({ participant_id: proj.participant_id, conversation_id: proj.conversation_id })
  expect(rec2.one('CHILD-FOLLOWUP-2').toolsJson).toBe(rec2.one('CHILD-FOLLOWUP-1').toolsJson)
  // the child that ran under no order: the same child participant, no order taken on, its own conversation's tools
  const r3 = await ended(c, String((await json(await c.post(`/api/runs/run_legacychild000002/resume`, { text: 'CHILD-2-FOLLOWUP' }))).id))
  expect(r3.status).toBe('done')
  expect(r3.work_order).toBeNull()
  expect(collabOf(r3).participant_role).toBe('child')
  expect(collabOf(r3).participant_id).toBe(proj.participant_id)
  expect(collabOf(r3).placement.surface).toBe('card')
  expect(rec2.one('CHILD-2-FOLLOWUP').tools).toEqual(['read_file'])
  // the old rows are as they were
  const old = repo.getRun(app.state.conn, child)!
  expect([old.user_text, old.parent_run_id, old.resumes_run_id, old.status]).toEqual(['LEGACY-CHILD', t1, null, 'done'])
}, 180_000)

test('one key, one intent: a first thread message with other effort or images, an interaction with other words — refused, never the first request\'s answer', async () => {
  app = await makeApp()
  setModel(app.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const { c, sid } = await openSnapshot(app)
  const g = await graphOf(c, sid)
  const main = g.main_participant_id
  if (main) {
    const one = await json(await c.post(`/api/participants/${main}/messages`, { text: 'FIRST', client_request_id: 'first-msg-key-01', thinking: 'low' }))
    await ended(c, String(one.id))
    const same = await json(await c.post(`/api/participants/${main}/messages`, { text: 'FIRST', client_request_id: 'first-msg-key-01', thinking: 'low' }))
    expect(same.id).toBe(one.id)
    const other = await attempt(c, `/api/participants/${main}/messages`, { text: 'FIRST', client_request_id: 'first-msg-key-01', thinking: 'high' })
    expect(other.status).toBe(409)
  }
  const body = { text: 'two alone', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' }, client_request_id: 'interaction-key-01' }
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, body))
  await until(() => repo.getInteraction(app!.state.conn, String(ix.id))!.status, (s) => s !== 'running', 'the group')
  const again = await json(await c.post(`/api/sessions/${sid}/interactions`, body))
  expect(again.id).toBe(ix.id)
  const other = await attempt(c, `/api/sessions/${sid}/interactions`, { ...body, text: 'two others' })
  expect(other.status).toBe(409)
  expect(other.body.code).toBe('key_conflict')
  expect(repo.listInteractions(app.state.conn, sid)).toHaveLength(1)
  // a thread message naming an interaction member's run: refused (its follow-up is a step of its group)
  const a1 = String(repo.listNodes(app.state.conn, String(ix.id))[0]!.run_id)
  const toMember = await attempt(c, `/api/sessions/${sid}/chat`, { text: 'INTO-MEMBER', resumes_run_id: a1 })
  expect(toMember.status).toBe(400)
  expect(toMember.text).toContain('/resume')
}, 60_000)

test("an interaction says who started it as its creation recorded it: a connector's client, else the person", async () => {
  app = await makeApp()
  const { c, sid } = await openSnapshot(app)
  setModel(app.state, AGENT, scriptedModel(() => modelResponse([textPart('answer')])))
  const viaChatGpt = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'each of you, alone', participants: [{ model: AGENT, id: PA }, { model: AGENT, id: PB }], plan: { template: 'independent' } }, { [CONNECTOR_HEADER]: 'ChatGPT' }))
  await until(() => repo.getInteraction(app!.state.conn, String(viaChatGpt.id))!.status, (s) => s === 'done', 'the connector\'s group done')
  const mine = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'again, alone', participants: [{ model: AGENT, id: PA }, { model: AGENT, id: PB }], plan: { template: 'independent' } }))
  await until(() => repo.getInteraction(app!.state.conn, String(mine.id))!.status, (s) => s === 'done', 'the person\'s group done')
  const g = await graphOf(c, sid)
  const originOf = (id: unknown) => g.groups.find((x) => x.id === id)!.origin!
  expect(originOf(viaChatGpt.id)).toMatchObject({ actor: 'connector', client: 'ChatGPT', basis: 'recorded' })
  expect(originOf(mine.id)).toMatchObject({ actor: 'person', basis: 'recorded' })
}, 60_000)

test('a session takes a second interaction while the first is under way: both run, side by side', async () => {
  app = await makeApp()
  const { c, sid } = await openSnapshot(app)
  const { ix: first } = await busyGroup(c, sid)                                          // two of its members held on the gate
  expect(repo.getInteraction(app.state.conn, first)!.status).toBe('running')
  setModel(app.state, OTHER, scriptedModel(() => modelResponse([textPart('the second group answers')])))
  const second = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'another question, alone', participants: [{ model: OTHER, id: PA }, { model: OTHER, id: PB }], plan: { template: 'independent' } }))
  await until(() => repo.getInteraction(app!.state.conn, String(second.id))!.status, (s) => s === 'done', 'the second group done while the first still runs')
  expect(repo.getInteraction(app.state.conn, first)!.status).toBe('running')
  release()
  await until(() => repo.getInteraction(app!.state.conn, first)!.status, (s) => s === 'done', 'the first group done')
  const g = await graphOf(c, sid)
  expect(g.groups.filter((x) => x.kind === 'interaction').map((x) => x.status)).toEqual(['done', 'done'])
}, 60_000)
