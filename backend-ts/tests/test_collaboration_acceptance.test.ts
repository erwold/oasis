/** Acceptance of the multi-agent unification (docs/multi-agent-unification-design.md; the baseline gaps P1–P11 of
 *  docs/multi-agent-baseline-audit.md, appendix B): what actually reaches a model and what a caller may do, checked on
 *  the requests a scripted model is sent and on the public API — the collaboration graph read through the contract's
 *  own schemas — never on an implementation's private tables or helpers.
 *
 *  Written before the runtime (the branch holds only the contract): every test here is expected to FAIL on the
 *  pre-v25 baseline, each at the gap it names; docs/multi-agent-acceptance.md lists what each one saw there. They pass
 *  once the design's runtime is in. Scripted models only; the suite's preload network guard stays as it is; temporary
 *  databases only (the legacy case builds a schema-v24 database from tests/fixtures/collaboration_v24.sql in a temp
 *  folder — no owner database is read). */

import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  ACTIVE_INTERACTION_STATUSES, COLLAB_SCHEMA_VERSION, SCHEMA_VERSION, type CollaborationGraph,
} from '@oasis-code/contract'
import { connect } from '../src/db/database.ts'
import { Harness } from '../src/director/harness.ts'
import { buildServer } from '../src/director/server.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import {
  AGENT, OTHER, PA, PB, PC, Recorder, aliasOf, attempt, chat, collabOf, edgesOf, ended, footprint, getRun,
  buildLegacyV24, graphOf, graphRun, independent, legacyAnswer, interactionDetail, isPrefix, legacyRows, nodeOf, openDirect,
  openSessionOf, openSnapshot, rewriteAsV24, settled, structure, until, v24Database, type Row, type Seen,
} from './collaboration_acceptance_helpers.ts'
import { sleep, testSettings } from './harness.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
let gates: (() => void)[] = []
let mcp: McpClient | null = null
afterEach(async () => {
  for (const open of gates) open()
  gates = []
  if (mcp) await mcp.close()
  mcp = null
  if (app) await app.close()
  app = null
})

/** A gate a scripted model waits on (opened by the test, or by afterEach). */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const wait = new Promise<void>((r) => { open = r })
  gates.push(open)
  return { wait, open }
}

/** Answers that never repeat the words they were asked (so a marker found in a request came from where the test
 *  put it, not from an echo): a participant's own line, or the thread's. */
const plain = (s: Seen): string => `fine (${aliasOf(s.text) ?? 'thread'})`

const runsOfInteraction = (a: App, id: string): number =>
  Number((a.state.conn.get('SELECT count(*) AS n FROM runs WHERE interaction_id = ?', [id]) as { n: number }).n)

// ---- 1. a member's follow-ups ---------------------------------------------------------------------------------------

test('P1: a member followed up twice stays one participant, each follow-up a step of its interaction, not counted in its budget; the thread stays the main agent\'s', async () => {
  app = await makeApp()
  const rec = new Recorder()
  rec.install(app, AGENT, plain)
  const { c, sid } = await openSnapshot(app)
  const t0 = await chat(c, sid, { text: 'THREAD-T0 begins' })
  const d = await independent(c, sid, [PA, PB])
  expect(d.status).toBe('done')
  const a1 = String(nodeOf(d, PA).run_id)
  const aNode = String(nodeOf(d, PA).id)

  const first = await attempt(c, `/api/runs/${a1}/resume`, { text: 'FOLLOWUP-ONE for A' })
  expect(first.status, first.text).toBe(200)
  const r2 = await ended(c, String(first.body.id))
  const second = await attempt(c, `/api/runs/${r2.id}/resume`, { text: 'FOLLOWUP-TWO for A' })
  expect(second.status, `the second follow-up (baseline: 400 "this run is the session thread's own") — ${second.text}`).toBe(200)
  const r3 = await ended(c, String(second.body.id))

  // both are steps of the interaction: on its board, outside its budget's count
  for (const r of [r2, r3]) {
    expect(r.status).toBe('done')
    expect(r.interaction_id, `follow-up ${String(r.id)} belongs to the interaction`).toBe(d.id)
    expect(r.interaction_node).toBeTruthy()
    expect(r.interaction_node).not.toBe(aNode)
  }
  expect(r2.resumes_run_id).toBe(a1)
  expect(r3.resumes_run_id).toBe(r2.id)
  const after = await interactionDetail(c, d.id)
  expect(after.runs_started).toBe(d.runs_started)
  expect(runsOfInteraction(app, d.id)).toBe(4)
  const followups = after.nodes.filter((n) => n.kind === 'followup')
  expect(followups.map((n) => n.run_id).sort()).toEqual([String(r2.id), String(r3.id)].sort())
  for (const n of followups) expect(n.participant).toBe(PA)

  // one stable participant, one conversation continued at its head
  const c1 = collabOf(await getRun(c, a1))
  const c2 = collabOf(r2)
  const c3 = collabOf(r3)
  expect(c1.participant_role).toBe('member')
  expect([c2.participant_id, c3.participant_id]).toEqual([c1.participant_id, c1.participant_id])
  expect([c2.conversation_id, c3.conversation_id]).toEqual([c1.conversation_id, c1.conversation_id])
  expect(c2.placement.surface).toBe('group')
  expect(c3.origin.request).toBe('followup')
  expect(c3.origin.actor).toBe('person')

  // what A was sent: its own conversation, byte for byte, with its own tool list; nothing of B
  const s2 = rec.one('FOLLOWUP-ONE')
  const s3 = rec.one('FOLLOWUP-TWO')
  expect(s2.text).toContain(`You are ${PA}.`)
  expect(s2.text).not.toContain(`You are ${PB}.`)
  expect(isPrefix(s2.wire, s3.wire)).toBe(true)
  expect(s3.toolsJson).toBe(s2.toolsJson)

  // the graph: the member, its follow-up steps, the continuation
  const g = await graphOf(c, sid)
  const member = g.participants.find((p) => p.id === c1.participant_id)!
  expect(member.role).toBe('member')
  expect(member.group).toEqual({ kind: 'interaction', id: d.id })
  expect(member.latest_run_id).toBe(String(r3.id))
  expect(g.nodes.filter((n) => n.kind === 'followup' && n.participant_id === c1.participant_id).length).toBe(2)
  expect(g.groups.find((x) => x.id === d.id)!.runs_started).toBe(d.runs_started)                 // follow-ups are not counted
  const conv = g.conversations.find((x) => x.id === c1.conversation_id)!
  expect(conv.run_ids).toEqual([a1, String(r2.id), String(r3.id)])
  expect(conv.head_run_id).toBe(String(r3.id))

  // the thread is still the main agent's: not the member's runs, and the next message continues the main agent
  expect(g.main_participant_id).not.toBeNull()
  expect(g.main_participant_id).not.toBe(c1.participant_id)
  const detail = await json(await c.get(`/api/sessions/${sid}`))
  expect(detail.main_participant_id).toBe(g.main_participant_id)
  const threadIds = (detail.runs as Row[]).map((r) => r.id)
  expect(threadIds).toContain(t0.id)
  expect(threadIds).not.toContain(r2.id)
  expect(threadIds).not.toContain(r3.id)
  const next = await chat(c, sid, { text: 'THREAD-NEXT message' })
  expect(next.resumes_run_id).toBe(t0.id)
  expect(collabOf(next).participant_id).toBe(g.main_participant_id)
  const sn = rec.one('THREAD-NEXT')
  expect(sn.text).toContain('THREAD-T0')
  expect(sn.text).not.toContain('FOLLOWUP-ONE')
}, 90_000)

test('follow-ups of a member are not counted in its interaction\'s budget: more of them than the budget allows all start; the budget and its count stay', async () => {
  app = await makeApp()
  new Recorder().install(app, AGENT, plain)
  const { c, sid } = await openSnapshot(app)
  const d = await independent(c, sid, [PA, PB])
  let head = String(nodeOf(d, PA).run_id)
  const budgetOf = (x: Record<string, unknown>) => (x.budget as { max_runs: number }).max_runs
  const extra = budgetOf(d) + 2
  for (let i = 0; i < extra; i++) {
    const res = await attempt(c, `/api/runs/${head}/resume`, { text: `budget step ${i}` })
    expect(res.status, `follow-up #${i + 1}: ${res.text}`).toBe(200)
    head = String((await ended(c, String(res.body.id))).id)
  }
  const det = await interactionDetail(c, d.id)
  expect(budgetOf(det)).toBe(budgetOf(d))
  expect(det.runs_started).toBe(d.runs_started)
  expect(runsOfInteraction(app, d.id)).toBe(d.runs_started + extra)
}, 180_000)

test('a follow-up of a settled interaction starts that step only: its other queued step stays queued, its status stays', async () => {
  app = await makeApp()
  const rec = new Recorder()
  rec.install(app, AGENT, (s) => {
    if (aliasOf(s.text) === PA && !s.last.includes('AGAIN')) throw new Error('scripted failure of A')
    return plain(s)
  })
  const { c, sid } = await openSnapshot(app)
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, {
    text: 'three of you', participants: [PA, PB, PC].map((id) => ({ model: AGENT, id })),
    plan: { nodes: [{ id: 'a1', participant: PA }, { id: 'b1', participant: PB }, { id: 'c1', participant: PC, depends_on: ['a1'] }] },
  }))
  const d = await settled(c, String(ix.id))
  expect(nodeOf(d, PA).status).toBe('error')
  expect(nodeOf(d, PC).status).toBe('queued')
  const b1 = String(nodeOf(d, PB).run_id)

  const fu = await attempt(c, `/api/runs/${b1}/resume`, { text: 'B-FOLLOWUP only this' })
  expect(fu.status, fu.text).toBe(200)
  const r = await ended(c, String(fu.body.id))
  expect(r.interaction_id).toBe(d.id)
  await sleep(300)
  const after = await interactionDetail(c, d.id)
  expect(after.status).toBe(d.status)
  expect(nodeOf(after, PC).status).toBe('queued')
  expect(nodeOf(after, PC).run_id ?? null).toBeNull()
  expect(after.runs_started).toBe(d.runs_started)                                          // a follow-up is not counted
  expect(rec.seen.filter((s) => aliasOf(s.text) === PC)).toEqual([])

}, 90_000)

test('a finished interaction is brought back by steps while another interaction of the session runs (P4, groups side by side)', async () => {
  app = await makeApp()
  new Recorder().install(app, AGENT, plain)
  const hold = gate()
  new Recorder().install(app, OTHER, async () => { await hold.wait; return 'y' })
  const { c, sid } = await openSnapshot(app)
  const x = await independent(c, sid, [PA, PB])
  expect(x.status).toBe('done')
  // from here every model waits: a step of X brought back would still be running when X is looked at
  new Recorder().install(app, AGENT, async () => { await hold.wait; return 'x again' })
  const y = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'Y', participants: [PA, PB].map((id) => ({ model: OTHER, id })), plan: { template: 'independent' } }))
  await until(() => interactionDetail(c, String(y.id)), (v) => v.status === 'running', 'Y to run')
  const xRuns = runsOfInteraction(app, x.id)
  const steps = await attempt(c, `/api/interactions/${x.id}/steps`, { nodes: [{ id: 'extra', participant: PB, depends_on: [], receives: [], workspace: 'own' }] })
  expect(steps.status, steps.text.slice(0, 160)).toBe(200)
  await until(() => interactionDetail(c, x.id), (v) => (ACTIVE_INTERACTION_STATUSES as readonly string[]).includes(v.status), 'X under way again beside Y')
  expect(runsOfInteraction(app, x.id)).toBe(xRuns + 1)                                   // its one new step
  hold.open()
  await settled(c, String(y.id))
  await settled(c, x.id)
}, 90_000)

// ---- 2. citations and handed-over answers ----------------------------------------------------------------------------

test('a citation names the exact run and hands nothing of it over: the cited edge says content_delivered false', async () => {
  app = await makeApp()
  const rec = new Recorder()
  rec.install(app, AGENT, (s) => (aliasOf(s.text) === PA ? 'CITED-BODY of A: the list is 1, 2, 3' : plain(s)))
  const { c, sid } = await openSnapshot(app)
  await chat(c, sid, { text: 'THREAD-T0' })
  const d = await independent(c, sid, [PA, PB])
  const a1 = String(nodeOf(d, PA).run_id)

  const res = await attempt(c, `/api/sessions/${sid}/chat`, { text: 'CITING-MESSAGE see that run', cites: [{ run_id: a1, note: 'NOTE-ABOUT-A' }] })
  expect(res.status, res.text).toBe(200)
  const run = await ended(c, String(res.body.id))
  const s = rec.one('CITING-MESSAGE')
  expect(s.text).not.toContain('CITED-BODY')
  expect(s.last, 'the agent is told which run the message cites').toContain(a1)

  const g = await graphOf(c, sid)
  const cited = edgesOf(g, 'cited', a1, String(run.id))
  expect(cited.length).toBe(1)
  const meta = cited[0]!.meta as { content_delivered: boolean; note: string | null; by: string }
  expect(meta.content_delivered).toBe(false)
  expect(meta.note).toBe('NOTE-ABOUT-A')
  expect(meta.by).toBe('person')
  expect(edgesOf(g, 'received', a1, String(run.id))).toEqual([])

  // a follow-up of B citing A: B is not handed A's answer either
  const b1 = String(nodeOf(d, PB).run_id)
  const fu = await attempt(c, `/api/runs/${b1}/resume`, { text: 'B-CITES-A', cites: [{ run_id: a1 }] })
  expect(fu.status, fu.text).toBe(200)
  const r = await ended(c, String(fu.body.id))
  expect(rec.one('B-CITES-A').text).not.toContain('CITED-BODY')
  expect(edgesOf(await graphOf(c, sid), 'cited', a1, String(r.id)).length).toBe(1)
}, 90_000)

const LONG = ['LONG-HEAD of the answer', ...Array.from({ length: 320 }, (_, i) => `line ${i}: finding ${i * 7} holds for case ${i % 13}`), 'LONG-TAIL of the answer'].join('\n')

test('receive_run_ids hands the exact run\'s whole answer (> 6000 chars) to the new run, recorded as received from that run — not the participant\'s later one; the conversation keeps its prefix and tools', async () => {
  expect(LONG.length).toBeGreaterThan(9000)
  app = await makeApp()
  const rec = new Recorder()
  rec.install(app, AGENT, (s) => {
    if (aliasOf(s.text) === PA) return s.last.includes('A-AGAIN') ? 'A-SECOND-ANSWER' : LONG
    return plain(s)
  })
  const { c, sid } = await openSnapshot(app)
  await chat(c, sid, { text: 'THREAD-T0' })
  const d = await independent(c, sid, [PA, PB])
  const a1 = String(nodeOf(d, PA).run_id)

  const res = await attempt(c, `/api/sessions/${sid}/chat`, { text: 'HANDOVER-MESSAGE take it', receive_run_ids: [a1] })
  expect(res.status, res.text).toBe(200)
  const run = await ended(c, String(res.body.id))
  const s1 = rec.one('HANDOVER-MESSAGE')
  expect(s1.last.includes(LONG), 'the whole answer is in the opening message').toBe(true)

  const g = await graphOf(c, sid)
  const received = edgesOf(g, 'received', a1, String(run.id))
  expect(received.length).toBe(1)
  const meta = received[0]!.meta as { content_delivered: boolean; via: string; packet: string; answer_chars: number | null; handed_chars: number | null }
  expect(meta).toMatchObject({ content_delivered: true, via: 'dispatch', packet: 'whole', answer_chars: LONG.length, handed_chars: LONG.length })
  expect(edgesOf(g, 'cited', a1, String(run.id))).toEqual([])

  // A answers again: its head moves; the edge stays on the run that was handed over
  const again = await attempt(c, `/api/runs/${a1}/resume`, { text: 'A-AGAIN please' })
  expect(again.status, again.text).toBe(200)
  const a2 = await ended(c, String(again.body.id))
  const g2 = await graphOf(c, sid)
  expect(edgesOf(g2, 'received', a1, String(run.id)).length).toBe(1)
  expect(edgesOf(g2, 'received', String(a2.id), null)).toEqual([])

  // the main conversation goes on: the request before is a prefix of the next, the tool list the same, and nothing
  // of A's later answer was added
  const next = await chat(c, sid, { text: 'HANDOVER-NEXT go on' })
  expect(next.resumes_run_id).toBe(run.id)
  const s2 = rec.one('HANDOVER-NEXT')
  expect(isPrefix(s1.wire, s2.wire)).toBe(true)
  expect(s2.toolsJson).toBe(s1.toolsJson)
  expect(s2.text).not.toContain('A-SECOND-ANSWER')
}, 90_000)

// ---- 3. refusals without side effects; heads; keys ------------------------------------------------------------------

test('references to another session\'s run, a running run, a missing run or the same run twice are refused, and a refused call leaves no run, workspace, step or record behind', async () => {
  app = await makeApp()
  new Recorder().install(app, AGENT, plain)
  const hold = gate()
  new Recorder().install(app, OTHER, async () => { await hold.wait; return 'late' })
  const { c, sid, pid } = await openSnapshot(app)
  await chat(c, sid, { text: 'THREAD-T0' })
  const d = await independent(c, sid, [PA, PB])
  const a1 = String(nodeOf(d, PA).run_id)
  const b1 = String(nodeOf(d, PB).run_id)
  const other = await openSessionOf(c, pid, 'another session')
  const foreign = String((await chat(c, other.sid, { text: 'elsewhere' })).id)
  const live = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'a long separate task', model: OTHER } }))
  const L = String(live.id)
  await until(() => getRun(c, L), (r) => r.status === 'running', 'the separate run to be running')
  const missing = 'run_doesnotexist0000'

  const before = footprint(app.state.conn, sid)
  const ixBefore = await interactionDetail(c, d.id)
  const chatPath = `/api/sessions/${sid}/chat`
  const cases: [string, string, Record<string, unknown>, number[]][] = [
    ['chat cites another session\'s run', chatPath, { text: 'BAD', cites: [{ run_id: foreign }] }, [400]],
    ['chat receives another session\'s run', chatPath, { text: 'BAD', receive_run_ids: [foreign] }, [400]],
    ['chat cites a running run', chatPath, { text: 'BAD', cites: [{ run_id: L }] }, [409]],
    ['chat receives a running run', chatPath, { text: 'BAD', receive_run_ids: [L] }, [409]],
    ['chat cites a missing run', chatPath, { text: 'BAD', cites: [{ run_id: missing }] }, [400, 404]],
    ['chat receives a missing run', chatPath, { text: 'BAD', receive_run_ids: [missing] }, [400, 404]],
    ['chat receives one run twice', chatPath, { text: 'BAD', receive_run_ids: [a1, a1] }, [400, 409, 422]],
    ['chat cites one run twice', chatPath, { text: 'BAD', cites: [{ run_id: a1 }, { run_id: a1 }] }, [400, 409, 422]],
    ['follow-up receives another session\'s run', `/api/runs/${b1}/resume`, { text: 'BAD', receive_run_ids: [foreign] }, [400]],
    ['follow-up cites a running run', `/api/runs/${b1}/resume`, { text: 'BAD', cites: [{ run_id: L }] }, [409]],
    ['separate task receives another session\'s run', `/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'BAD' }, workspace_policy: 'isolated', receive_run_ids: [foreign] }, [400]],
    ['separate task cites a missing run', `/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'BAD' }, workspace_policy: 'isolated', cites: [{ run_id: missing }] }, [400, 404]],
  ]
  const wrong: string[] = []
  for (const [label, path, body, statuses] of cases) {
    const res = await attempt(c, path, body)
    if (!statuses.includes(res.status)) wrong.push(`${label}: answered ${res.status}, expected ${statuses.join('|')} — ${res.text.slice(0, 160)}`)
    if (res.status === 200 && res.body.id) await until(() => getRun(c, String(res.body.id)), (r) => !['queued', 'running'].includes(String(r.status)), 'a wrongly started run to end').catch(() => null)
  }
  expect(wrong).toEqual([])
  expect(footprint(app.state.conn, sid)).toEqual(before)
  const ixAfter = await interactionDetail(c, d.id)
  expect([ixAfter.revision, ixAfter.nodes.length, ixAfter.runs_started]).toEqual([ixBefore.revision, ixBefore.nodes.length, ixBefore.runs_started])
  hold.open()
  await ended(c, L)
}, 90_000)

test('expected_head_run_id: a stale head is a 409 and two follow-ups racing for one head start one run; one client key is one run, and the key again for another target or other words is refused', async () => {
  app = await makeApp()
  const rec = new Recorder()
  rec.install(app, AGENT, plain)
  const { c, sid } = await openSnapshot(app)
  await chat(c, sid, { text: 'THREAD-T0' })
  const d = await independent(c, sid, [PA, PB])
  const a1 = String(nodeOf(d, PA).run_id)
  const b1 = String(nodeOf(d, PB).run_id)
  const runs = () => footprint(app!.state.conn, sid).runs

  const ok = await attempt(c, `/api/runs/${a1}/resume`, { text: 'HEAD-ONE', expected_head_run_id: a1 })
  expect(ok.status, ok.text).toBe(200)
  const a2 = String((await ended(c, String(ok.body.id))).id)
  let n = runs()
  const stale = await attempt(c, `/api/runs/${a1}/resume`, { text: 'HEAD-STALE', expected_head_run_id: a1 })
  expect(stale.status, stale.text).toBe(409)
  expect(runs()).toBe(n)
  expect(rec.opening('HEAD-STALE')).toEqual([])

  // two at once on one head: one starts, the other is told the head moved (or the participant is busy)
  n = runs()
  const race = await Promise.all(['RACE-1', 'RACE-2'].map((text) => attempt(c, `/api/runs/${a2}/resume`, { text, expected_head_run_id: a2 })))
  expect(race.map((r) => r.status).sort()).toEqual([200, 409])
  expect(runs()).toBe(n + 1)
  const aHead = String((await ended(c, String(race.find((r) => r.status === 200)!.body.id))).id)

  // one key, sent twice at once: one run
  n = runs()
  const key = 'acceptance-followup-key-1'
  const twice = await Promise.all([0, 1].map(() => attempt(c, `/api/runs/${b1}/resume`, { text: 'KEYED B', client_request_id: key })))
  expect(twice.map((r) => r.status)).toEqual([200, 200])
  expect(twice[0]!.body.id).toBe(twice[1]!.body.id)
  expect(runs()).toBe(n + 1)
  const keyed = String(twice[0]!.body.id)
  await ended(c, keyed)

  // the same key for another participant, or other words: refused — not the first run answered back
  for (const [label, path, body] of [
    ['another target', `/api/runs/${aHead}/resume`, { text: 'KEYED B', client_request_id: key }],
    ['other words', `/api/runs/${b1}/resume`, { text: 'KEYED B, other words', client_request_id: key }],
  ] as const) {
    const res = await attempt(c, path, body)
    expect([400, 409, 422], `${label}: ${res.status} ${res.text.slice(0, 200)}`).toContain(res.status)
    expect(res.body.id).not.toBe(keyed)
  }
  expect(runs()).toBe(n + 1)

  // the thread's composer key: the same twice at once is one run; other words under it are refused
  n = runs()
  const ck = 'acceptance-chat-key-0001'
  const chats = await Promise.all([0, 1].map(() => attempt(c, `/api/sessions/${sid}/chat`, { text: 'KEYED-CHAT', client_request_id: ck })))
  expect(chats.map((r) => r.status)).toEqual([200, 200])
  expect(chats[0]!.body.id).toBe(chats[1]!.body.id)
  await ended(c, String(chats[0]!.body.id))
  const otherWords = await attempt(c, `/api/sessions/${sid}/chat`, { text: 'KEYED-CHAT but different', client_request_id: ck })
  expect([400, 409, 422], `${otherWords.status} ${otherWords.text.slice(0, 200)}`).toContain(otherWords.status)
  expect(runs()).toBe(n + 1)
}, 90_000)

// ---- 4. orders, separate tasks and the main thread ---------------------------------------------------------------------

test('a read-only order is inherited or narrowed on every way back into it (P6, P5): /chat naming it, a follow-up, a widening; the main thread keeps its own conversation and tools', async () => {
  app = await makeApp()
  const rec = new Recorder()
  rec.install(app, AGENT, plain)
  const { c, sid } = await openSnapshot(app)
  const t0 = await chat(c, sid, { text: 'MAIN-T0' })
  const wo = await ended(c, String((await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'RO-ORDER look only', read_only: true, tools: ['read_file'] } }))).id))
  expect(wo.status).toBe('done')
  const woSeen = rec.one('RO-ORDER')
  const allowed = new Set(woSeen.tools)

  // /chat naming the order's run: refused, or that order's participant under that order — never a widened run
  const viaChat = await attempt(c, `/api/sessions/${sid}/chat`, { text: 'CHAT-INTO-ORDER', resumes_run_id: wo.id })
  if (viaChat.status === 200) {
    const r = await ended(c, String(viaChat.body.id))
    expect(r.work_order, 'the run continuing a read-only order keeps the order (baseline: null, 15 tools)').not.toBeNull()
    expect((r.work_order as Row).read_only).toBe(true)
    expect(rec.one('CHAT-INTO-ORDER').tools.filter((t) => !allowed.has(t))).toEqual([])
    expect(collabOf(r).participant_id).toBe(collabOf(wo).participant_id)
  } else {
    expect([400, 409], viaChat.text).toContain(viaChat.status)
  }

  // a follow-up cannot widen it; without a patch it inherits it, with the same tool list
  for (const patch of [{ read_only: false }, { tools: ['read_file', 'bash'] }]) {
    const res = await attempt(c, `/api/runs/${wo.id}/resume`, { text: 'WIDEN', work_order: patch })
    expect(res.status, `${JSON.stringify(patch)}: ${res.text}`).toBe(400)
  }
  const fu = await attempt(c, `/api/runs/${wo.id}/resume`, { text: 'RO-FOLLOWUP' })
  expect(fu.status, fu.text).toBe(200)
  const fr = await ended(c, String(fu.body.id))
  expect((fr.work_order as Row).read_only).toBe(true)
  expect(rec.one('RO-FOLLOWUP').toolsJson).toBe(woSeen.toolsJson)

  // /chat naming a member's run: refused, or that member's step
  const d = await independent(c, sid, [PA, PB])
  const a1 = String(nodeOf(d, PA).run_id)
  const toMember = await attempt(c, `/api/sessions/${sid}/chat`, { text: 'CHAT-INTO-MEMBER', resumes_run_id: a1 })
  if (toMember.status === 200) {
    const r = await ended(c, String(toMember.body.id))
    expect(r.interaction_id, 'a /chat continuing a member is that member\'s step').toBe(d.id)
    expect(collabOf(r).participant_id).toBe(collabOf(await getRun(c, a1)).participant_id)
  } else {
    expect([400, 409], toMember.text).toContain(toMember.status)
  }

  // an order naming the main agent's run: refused, or a conversation of its own — never the main agent's (P5)
  const onMain = await attempt(c, `/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'ORDER-ON-MAIN', resumes_run_id: t0.id, read_only: true, tools: ['read_file'] } })
  if (onMain.status === 200) {
    const r = await ended(c, String(onMain.body.id))
    const rc = collabOf(r)
    expect(rc.participant_role).not.toBe('main')
    expect(rc.conversation_id).not.toBe(collabOf(t0).conversation_id)
  } else {
    expect([400, 409], onMain.text).toContain(onMain.status)
  }

  // the thread: the main agent's conversation, its tool list unchanged
  const next = await chat(c, sid, { text: 'MAIN-NEXT' })
  expect(next.resumes_run_id).toBe(t0.id)
  expect(next.work_order).toBeNull()
  const sn = rec.one('MAIN-NEXT')
  expect(sn.toolsJson).toBe(rec.one('MAIN-T0').toolsJson)
  for (const marker of ['RO-ORDER', 'CHAT-INTO-ORDER', 'RO-FOLLOWUP', 'CHAT-INTO-MEMBER', 'ORDER-ON-MAIN']) expect(sn.text).not.toContain(marker)
}, 120_000)

test('an isolated separate task over a direct folder has a workspace of its own, a card, a summary in the thread that jumps to it; it cannot borrow the main conversation (P9), and leaves the main thread unpolluted', async () => {
  app = await makeApp()
  const rec = new Recorder()
  rec.install(app, AGENT, plain)
  const root = join(tempDir(), 'src_folder')
  mkdirSync(root)
  writeFileSync(join(root, 'data.txt'), 'seed\n')
  const { c, sid, ws } = await openDirect(app, root)
  const t0 = await chat(c, sid, { text: 'DIRECT-T0' })

  const borrow = await attempt(c, `/api/sessions/${sid}/work-orders`, { workspace_policy: 'isolated', work_order: { prompt: 'ISO-RESUME of the main', resumes_run_id: t0.id } })
  if (borrow.status === 200) {
    const r = await ended(c, String(borrow.body.id))
    expect(r.workspace_id, 'an isolated task never runs in the session folder').not.toBe(ws)
    expect(collabOf(r).participant_role).not.toBe('main')
  } else {
    expect([400, 409], borrow.text).toContain(borrow.status)
  }

  const sep = await ended(c, String((await json(await c.post(`/api/sessions/${sid}/work-orders`, { workspace_policy: 'isolated', work_order: { prompt: 'ISO-PRIVATE task' } }))).id))
  expect(sep.status).toBe('done')
  expect(sep.workspace_id, 'an isolated separate task over a direct folder works in a workspace of its own').not.toBe(ws)
  const sc = collabOf(sep)
  expect(sc.participant_role).toBe('separate')
  expect(sc.placement.surface).toBe('card')
  const g = await graphOf(c, sid)
  const item = g.thread_items.find((t) => t.kind === 'dispatch' && t.entries.some((e) => e.run_id === sep.id))
  expect(item, 'the thread summarises the separate task').toBeDefined()
  if (item?.kind !== 'dispatch') throw new Error('not a dispatch item')
  const entry = item.entries.find((e) => e.run_id === sep.id)!
  expect(entry.focus).toEqual({ participant_id: sc.participant_id, run_id: String(sep.id) })
  expect(entry.status).toBe('done')
  expect(item.counts.total).toBe(item.entries.length)
  expect(item.counts.done).toBeGreaterThanOrEqual(1)

  const next = await chat(c, sid, { text: 'DIRECT-NEXT' })
  expect(next.resumes_run_id).toBe(t0.id)
  const sn = rec.one('DIRECT-NEXT')
  expect(sn.text).toContain('DIRECT-T0')
  expect(sn.text).not.toContain('ISO-PRIVATE')
  expect(sn.text).not.toContain('ISO-RESUME')
}, 90_000)

test('connector start_run(separate, constraints.resumes_run_id = a thread run) does not land in the session workspace (P9)', async () => {
  app = await makeApp()
  const rec = new Recorder()
  rec.install(app, AGENT, plain)
  const base = Harness.connect('http://localhost', 'test-token', { fetchImpl: (input, init) => Promise.resolve(app!.app.request(input, init)) })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await buildServer(base.as('ChatGPT')).connect(st)
  mcp = new McpClient({ name: 'acceptance', version: '0' })
  await mcp.connect(ct)
  const { c, sid, ws } = await openSnapshot(app)
  const t0 = await chat(c, sid, { text: 'CONNECTOR-T0' })
  const result = await mcp.callTool({ name: 'start_run', arguments: { session_id: sid, text: 'SEPARATE-WITH-RESUME', separate: true, constraints: { resumes_run_id: t0.id } } })
  const structured = result.structuredContent as Row | undefined
  if (!result.isError && structured?.id) {
    const r = await ended(c, String(structured.id))
    expect(r.workspace_id, 'a separate task continuing the thread run must not work in the session workspace').not.toBe(ws)
  }
  const next = await chat(c, sid, { text: 'CONNECTOR-NEXT' })
  expect(next.resumes_run_id).toBe(t0.id)
  expect(rec.one('CONNECTOR-NEXT').text).not.toContain('SEPARATE-WITH-RESUME')
}, 60_000)

// ---- 5. the legacy history: a v24 database migrated -----------------------------------------------------------------

test('a schema-v24 database (the fixture) migrates by connect to the structure of a fresh database, at the collaboration schema, with its backup', () => {
  const base = tempDir()
  mkdirSync(join(base, 'old'))
  const old = join(base, 'old', 'index.db')
  const raw = v24Database(old)
  raw.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','legacy','/x','t','t')")
  raw.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at) VALUES ('s_1','p_1','t','m','t','t')")
  raw.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at, history_json) VALUES ('run_1','s_1','p_1','m','hi','done','t','[]')")
  raw.close()
  const migrated = connect(old)
  const fresh = connect(join(base, 'fresh', 'index.db'))
  try {
    expect(structure(migrated.db)).toEqual(structure(fresh.db))
    expect(SCHEMA_VERSION, 'the build is at the collaboration schema (v25 in the design) or later').toBeGreaterThanOrEqual(COLLAB_SCHEMA_VERSION)
    expect(Number((migrated.get('PRAGMA user_version') as { user_version: number }).user_version)).toBe(SCHEMA_VERSION)
    expect(existsSync(join(base, 'old', 'index.db.v24.bak'))).toBe(true)
    expect(migrated.get("SELECT history_json FROM runs WHERE id='run_1'")!.history_json).toBe('[]')
  } finally {
    migrated.close()
    fresh.close()
  }
})

const V24_RUN_COLUMNS = [
  'id', 'session_id', 'project_id', 'workspace_id', 'parent_run_id', 'resumes_run_id', 'spawned_by', 'label', 'model', 'model_config_json',
  'user_text', 'status', 'history_json', 'usage_json', 'manifest_json', 'budget_json', 'receipt_json', 'error', 'created_at', 'finished_at',
  'saved_seq', 'work_order_json', 'attachments_json', 'client_request_id', 'relay_id', 'relay_step', 'interaction_id', 'interaction_node',
]
const LEGACY_TABLES: [string, string][] = [['interactions', 'id'], ['interaction_nodes', 'interaction_id, id'], ['interaction_events', 'interaction_id, seq'], ['relays', 'id']]

/** The rows of the legacy tables, v24 columns only (the fixture's), as stored. */
let v24Columns: Record<string, string> | null = null
function legacyTables(db: Database): Record<string, Row[]> {
  if (v24Columns === null) {
    const shape = v24Database(join(tempDir(), 'shape.db'))
    v24Columns = Object.fromEntries(LEGACY_TABLES.map(([t]) => [t, (shape.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((r) => `"${r.name}"`).join(', ')]))
    shape.close()
  }
  return Object.fromEntries(LEGACY_TABLES.map(([t, order]) => [t, db.query(`SELECT ${v24Columns![t]} FROM "${t}" ORDER BY ${order}`).all() as Row[]]))
}


function legacyProjection(g: CollaborationGraph, ids: string[]): Record<string, [string | null, string | null, string | null]> {
  return Object.fromEntries(ids.map((id) => { const r = graphRun(g, id); return [id, [r.collab.participant_id, r.collab.conversation_id, r.collab.participant_role]] }))
}

test('legacy history: a v24 database with the old shapes migrates without a byte of its rows changed, projects stable participants and conversations without writing, and its orphaned follow-up chain continues twice as its member (P1, P3, P11 shapes)', async () => {
  const settings = testSettings()

  // ---- what a v24 build left (collaboration_acceptance_helpers.ts buildLegacyV24)
  const L = await buildLegacyV24(settings)
  const { sid, d, orphanHistory, ids } = L
  const { t1, t2, ra, rb, lastTurn, wo1, wo2, afterRelay, orphan1, orphan2, action, child, dangling, firstTurn } = ids
  const legacyIds = [t1, t2, ra, rb, firstTurn, lastTurn, wo1, wo2, afterRelay, orphan1, orphan2, action, child, dangling]
  const snapshot = new Database(settings.db_path, { readonly: true })
  const rowsBefore = legacyRows(snapshot, legacyIds, V24_RUN_COLUMNS)
  const tablesBefore = legacyTables(snapshot)
  snapshot.close()
  expect(rowsBefore[orphan1]!.history_json).toBe(orphanHistory)
  // every legacy run row, and (until a follow-up legitimately adds a step to A's interaction and counts it) every row of
  // the legacy interaction and relay tables; after that: the runs, the relay, and the interaction's earlier steps
  const unchanged = (a: App, when: string, continued = false) => {
    expect(legacyRows(a.state.conn.db, legacyIds, V24_RUN_COLUMNS), `legacy run rows ${when}`).toEqual(rowsBefore)
    const now = legacyTables(a.state.conn.db)
    if (!continued) { expect(now, `legacy interaction / relay rows ${when}`).toEqual(tablesBefore); return }
    expect(now.relays, `legacy relay rows ${when}`).toEqual(tablesBefore.relays!)
    const key = (r: Row) => `${String(r.interaction_id)}/${String(r.id)}`
    const earlier = new Set(tablesBefore.interaction_nodes!.map(key))
    expect(now.interaction_nodes!.filter((r) => earlier.has(key(r))), `the interaction's earlier steps ${when}`).toEqual(tablesBefore.interaction_nodes!)
  }

  // ---- the current build opens it: the migration
  app = await makeApp(settings)
  unchanged(app, 'after the migration')
  const fresh = connect(join(tempDir(), 'index.db'))
  try { expect(structure(app.state.conn.db)).toEqual(structure(fresh.db)) } finally { fresh.close() }
  expect(Number((app.state.conn.get('PRAGMA user_version') as { user_version: number }).user_version)).toBe(SCHEMA_VERSION)
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(COLLAB_SCHEMA_VERSION)
  expect(existsSync(`${settings.db_path}.v24.bak`)).toBe(true)

  // ---- the projection: read twice, the same, nothing written
  const rec = new Recorder()
  rec.install(app, AGENT, legacyAnswer)
  rec.install(app, OTHER, legacyAnswer)
  const c2 = new Client(app)
  const g1 = await graphOf(c2, sid)
  const g2 = await graphOf(c2, sid)
  unchanged(app, 'after two reads of the graph')
  const projected = legacyProjection(g1, legacyIds)
  expect(legacyProjection(g2, legacyIds)).toEqual(projected)
  expect(g2.participants.map((p) => p.id).sort()).toEqual(g1.participants.map((p) => p.id).sort())
  expect(g2.conversations.map((x) => x.id).sort()).toEqual(g1.conversations.map((x) => x.id).sort())
  for (const id of legacyIds) expect(graphRun(g1, id).collab.basis, `${id} is not presented as recorded`).not.toBe('recorded')
  expect(g1.legacy.projected_runs).toBeGreaterThanOrEqual(legacyIds.length - 1)

  const pid = (id: string) => projected[id]![0]
  const role = (id: string) => projected[id]![2]
  const main = g1.main_participant_id
  expect(main).not.toBeNull()
  expect([pid(t1), pid(t2), pid(afterRelay)]).toEqual([main, main, main])
  expect([role(ra), role(rb)]).toEqual(['member', 'member'])
  expect(pid(ra)).not.toBe(pid(rb))
  expect([pid(orphan1), pid(orphan2)], 'the v24 follow-ups of A are A\'s').toEqual([pid(ra), pid(ra)])
  expect([role(firstTurn), role(lastTurn)]).toEqual(['member', 'member'])
  expect(pid(firstTurn)).not.toBe(pid(lastTurn))
  expect(graphRun(g1, lastTurn).collab.placement.group).toEqual({ kind: 'relay', id: L.relayId })
  expect(role(wo1)).toBe('separate')
  expect(pid(wo2)).toBe(pid(wo1))
  expect(pid(action)).toBeNull()
  expect(graphRun(g1, action).collab.placement.surface).toBe('record')
  expect(role(child)).toBe('child')
  graphRun(g1, dangling)
  const thread = ((await json(await c2.get(`/api/sessions/${sid}`))).runs as Row[]).map((r) => r.id)
  expect(thread).toContain(t2)
  expect(thread).not.toContain(orphan1)

  // ---- the orphaned chain continues, twice, as A: A's prefix, A's view of its peers, a step of A's interaction
  const x1r = await attempt(c2, `/api/runs/${orphan2}/resume`, { text: 'RESUME-LEGACY-1' })
  expect(x1r.status, x1r.text).toBe(200)
  const x1 = await ended(c2, String(x1r.body.id))
  const s1 = rec.one('RESUME-LEGACY-1')
  const orphanWire = (JSON.parse(orphanHistory) as unknown[]).map((m) => JSON.stringify(m))
  expect(isPrefix(orphanWire, s1.wire), 'the continued conversation is the v24 history, byte for byte').toBe(true)
  expect(s1.text).toContain(`You are ${PA}.`)
  expect(s1.text).toContain(PB)
  expect(s1.text).not.toContain('LEGACY-B-ANSWER')
  const x2r = await attempt(c2, `/api/runs/${x1.id}/resume`, { text: 'RESUME-LEGACY-2' })
  expect(x2r.status, x2r.text).toBe(200)
  const x2 = await ended(c2, String(x2r.body.id))
  const s2 = rec.one('RESUME-LEGACY-2')
  expect(isPrefix(s1.wire, s2.wire)).toBe(true)
  expect(s2.toolsJson).toBe(s1.toolsJson)
  for (const x of [x1, x2]) {
    expect(collabOf(x).participant_id).toBe(pid(ra))
    expect(x.interaction_id).toBe(d.id)
  }
  // the thread goes on from its own last run: the one after the relay
  const m = await chat(c2, sid, { text: 'RESUME-MAIN' })
  expect(m.resumes_run_id).toBe(afterRelay)
  expect(collabOf(m).participant_id).toBe(main)
  const afterRelayWire = (JSON.parse(String(rowsBefore[afterRelay]!.history_json)) as unknown[]).map((x) => JSON.stringify(x))
  expect(isPrefix(afterRelayWire, rec.one('RESUME-MAIN').wire)).toBe(true)
  unchanged(app, 'after the old runs were continued', true)
  await app.close()
  app = null

  // ---- another process: the same projected ids
  app = await makeApp(settings)
  const g3 = await graphOf(new Client(app), sid)
  expect(legacyProjection(g3, legacyIds)).toEqual(projected)
  unchanged(app, 'in another process', true)
}, 180_000)

