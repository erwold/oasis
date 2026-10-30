/** The collaboration model's core (schema v25; docs/multi-agent-unification-design.md, docs/multi-agent-baseline-audit.md
 *  appendix B): the audit's probes P1–P12 kept as regression tests with the corrected expectations, and the rules the
 *  design adds — a participant's follow-ups stay that participant's (resumed again and again), a private follow-up never
 *  becomes the next group's common history, a thread message never continues an interaction's step, a read-only order
 *  is never dropped, a reference never poses as a handover, a key never answers for another intent. Scripted models only
 *  (the suite's preload refuses every non-loopback host). */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CollaborationGraph, InteractionDetail, Run } from '@oasis-code/contract'
import * as crepo from '../src/db/collab_repo.ts'
import * as repo from '../src/db/repo.ts'
import * as dstore from '../src/director/store.ts'
import { isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, sleep, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
let release: () => void = () => {}
afterEach(async () => { release(); release = () => {}; if (app) await app.close(); app = null })
const AGENT = 'scripted:a'
const userTexts = (messages: ModelMessage[]) => messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt)
  .map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n'))).join('\n')

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 25_000
  for (;;) { const v = await read(); if (ok(v)) return v; if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 400)}`); await sleep(20) }
}
async function snapshotSession() {
  app = await makeApp()
  const c = new Client(app)
  const p = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${p.id}/sessions`, { title: 'collab', model: AGENT }))
  return { c, sid: String(s.id), ws: String((s.workspace as Record<string, unknown>).id), pid: String(p.id) }
}
async function directSession() {
  app = await makeApp()
  const c = new Client(app)
  const root = join(tempDir(), 'src_folder')
  mkdirSync(root)
  writeFileSync(join(root, 'data.txt'), 'seed\n')
  const p = await json(await c.post('/api/projects', { source_path: root, mode: 'direct' }))
  const s = await json(await c.post(`/api/projects/${p.id}/sessions`, { title: 'collab', model: AGENT }))
  return { c, sid: String(s.id), ws: String(s.workspace_id) }
}
const done = (id: string) => until(() => app!.state.interactions.detail(repo.getInteraction(app!.state.conn, id)!), (ix) => ['done', 'waiting', 'error', 'cancelled'].includes(ix.status) && !ix.live)
const graph = async (c: Client, sid: string) => json<CollaborationGraph>(await c.get(`/api/sessions/${sid}/collaboration`))
const finishRun = async (id: unknown) => waitDone(app!.state, String(id))

test('P1 corrected: a participant\'s follow-ups stay its own — a step of its interaction, outside its budget, off the thread — and go on again and again', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('answer')])))
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'two alone', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const finished = await done(String(ix.id))
  const a = finished.nodes[0]!
  const first = repo.getRun(app!.state.conn, a.run_id!)!
  const followups: Record<string, unknown>[] = []
  let previous = a.run_id!
  for (const words of ['more from A', 'still more from A', 'and once more']) {
    const r = await json(await c.post(`/api/runs/${previous}/resume`, { text: words }))
    await finishRun(r.id)
    followups.push(r)
    previous = String(r.id)
  }
  const graphNow = await graph(c, sid)
  const collabOf = (id: string) => graphNow.runs.find((r) => r.id === id)!.collab
  for (const [i, r] of followups.entries()) {
    const row = repo.getRun(app!.state.conn, String(r.id))!
    expect(row.interaction_id).toBe(String(ix.id))
    expect(row.interaction_node).toBe(`fu-${i + 1}`)
    expect(row.workspace_id).toBe(first.workspace_id)                                      // its own copy, carried on
    expect(collabOf(row.id).participant_id).toBe(collabOf(first.id).participant_id)        // the same participant
    expect(collabOf(row.id).conversation_id).toBe(collabOf(first.id).conversation_id)      // one conversation, appended to
    expect(collabOf(row.id).placement.surface).toBe('group')
    expect(collabOf(row.id).origin).toMatchObject({ actor: 'person', request: 'followup', interaction_id: String(ix.id) })
  }
  const after = repo.getInteraction(app!.state.conn, String(ix.id))!
  expect(after.runs_started).toBe(2)                                                        // counted: the 2 steps; the 3 follow-ups are not
  expect(repo.listRunsOfInteraction(app!.state.conn, after.id)).toHaveLength(5)
  expect(after.status).toBe('done')                                                         // an ended group is not revived
  // each follow-up comes after the step whose run it continues (the previous follow-up is a step itself)
  expect(repo.listNodes(app!.state.conn, after.id).filter((n) => n.kind === 'followup').map((n) => [n.id, n.status, n.depends_on])).toEqual([
    ['fu-1', 'done', [a.id]], ['fu-2', 'done', ['fu-1']], ['fu-3', 'done', ['fu-2']],
  ])
  const sessionRuns = (await json(await c.get(`/api/sessions/${sid}`))).runs as Record<string, unknown>[]
  expect(sessionRuns.some((r) => followups.some((f) => f.id === r.id))).toBe(false)         // not the thread's
  const continues = graphNow.edges.filter((e) => e.kind === 'continues' && followups.some((f) => f.id === e.to.id)).map((e) => [e.from.id, e.to.id])
  expect(continues as unknown[]).toEqual([[a.run_id!, followups[0]!.id], [followups[0]!.id, followups[1]!.id], [followups[1]!.id, followups[2]!.id]])
}, 60_000)

test('P2 corrected: a private follow-up of participant A never becomes the next isolated group\'s common history', async () => {
  const { c, sid } = await directSession()
  const seen: string[] = []
  setModel(app!.state, AGENT, scriptedModel((messages: ModelMessage[]) => {
    const t = userTexts(messages)
    seen.push(t)
    return modelResponse([textPart(t.includes('PRIVATE-FOLLOWUP-FOR-A') ? 'A-PRIVATE-ANSWER' : 'answer')])
  }))
  const t0 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'thread start T0' }))
  await finishRun(t0.id)
  const x = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'group X', workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const xd = await done(String(x.id))
  const r2 = await json(await c.post(`/api/runs/${xd.nodes[0]!.run_id}/resume`, { text: 'PRIVATE-FOLLOWUP-FOR-A' }))
  await finishRun(r2.id)
  seen.length = 0
  const y = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'group Y', workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const yd = await done(String(y.id))
  expect(repo.getInteraction(app!.state.conn, yd.id)!.resumes_run_id).toBe(String(t0.id))
  expect(seen.length).toBe(2)
  expect(seen.filter((t) => t.includes('PRIVATE-FOLLOWUP-FOR-A') || t.includes('A-PRIVATE-ANSWER'))).toHaveLength(0)
}, 60_000)

test('P3 corrected: after a composer interaction in place, the next thread message continues the thread, not the last step', async () => {
  const { c, sid } = await directSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const t0 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'THREAD-T0' }))
  await finishRun(t0.id)
  const x = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'two in place', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const xd = await done(String(x.id))
  expect(xd.in_place).toBe(true)
  let sawT0 = false
  setModel(app!.state, AGENT, scriptedModel((messages: ModelMessage[]) => { sawT0 = userTexts(messages).includes('THREAD-T0'); return modelResponse([textPart('next')]) }))
  const next = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'and now?' }))
  await finishRun(next.id)
  expect(next.resumes_run_id).toBe(String(t0.id))
  expect(sawT0).toBe(true)
  // the steps' own history is unchanged: they are the members', on the group's board
  const g = await graph(c, sid)
  for (const n of xd.nodes) expect(g.runs.find((r) => r.id === n.run_id)!.collab).toMatchObject({ participant_role: 'member', placement: { surface: 'group' } })
}, 60_000)

test('P4, as groups now may run side by side: steps added to a finished interaction while another runs bring it back beside it', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('x')])))
  const x = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'X', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const xd = await done(String(x.id))
  const gate = new Promise<void>((r) => { release = r })
  setModel(app!.state, AGENT, scriptedModel(async () => { await gate; return modelResponse([textPart('y')]) }))
  const y = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'Y', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const p = xd.participants[0]!.id
  const res = await c.post(`/api/interactions/${x.id}/steps`, { nodes: [{ id: 'extra', participant: p, depends_on: [], receives: [], workspace: 'own' }] })
  expect(res.status).toBe(200)
  expect(repo.listNodes(app!.state.conn, String(x.id)).some((n) => n.id === 'extra')).toBe(true)
  expect(repo.getInteraction(app!.state.conn, String(x.id))!.status).toBe('running')
  release()
  await done(String(y.id))
  await done(String(x.id))
  expect(repo.listNodes(app!.state.conn, String(x.id)).find((n) => n.id === 'extra')!.status).toBe('done')
}, 60_000)

test('P5/P9 corrected: a work order that names a thread run to continue is refused before anything starts', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('x')])))
  const t0 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'T0' }))
  await finishRun(t0.id)
  const before = repo.listRuns(app!.state.conn, sid).length
  const refused = await json<{ detail: string }>(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'continue as an order', resumes_run_id: t0.id } }), 400)
  expect(refused.detail).toContain('not a separate task')
  expect(repo.listRuns(app!.state.conn, sid).length).toBe(before)
}, 60_000)

test('P6 corrected: /chat cannot continue a read-only order\'s run as a thread run (its order would be dropped); its own follow-up keeps the order', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('x')])))
  const wo = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'look only', read_only: true, tools: ['read_file'] } }))
  await finishRun(wo.id)
  const refused = await json<{ detail: string }>(await c.post(`/api/sessions/${sid}/chat`, { text: 'carry on', resumes_run_id: wo.id }), 400)
  expect(refused.detail).toContain('separate task')
  const follow = await json(await c.post(`/api/runs/${wo.id}/resume`, { text: 'carry on' }))
  await finishRun(follow.id)
  const row = repo.getRun(app!.state.conn, String(follow.id))!
  expect((row.work_order as Record<string, unknown>).read_only).toBe(true)
  expect((row.work_order as Record<string, unknown>).tools).toEqual(['read_file'])
  expect((follow.collab as Record<string, unknown>).participant_role).toBe('separate')
}, 60_000)

test('P11 corrected: a run that continues a run with no record of its own shows only its own messages', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('x')])))
  const t1 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'T1-TEXT' }))
  await finishRun(t1.id)
  const t2 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'T2-TEXT' }))
  await finishRun(t2.id)
  app!.state.conn.run("UPDATE runs SET history_json='[]' WHERE id=?", [String(t2.id)])
  const t3 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'T3-TEXT' }))
  await finishRun(t3.id)
  const shown = JSON.stringify((await json(await c.get(`/api/runs/${t3.id}/transcript`))).entries)
  expect(t3.resumes_run_id).toBe(String(t2.id))
  expect(shown.includes('T1-TEXT')).toBe(false)
  expect(shown.includes('T3-TEXT')).toBe(true)
}, 60_000)

test('P12 corrected: a key used again for another intent is refused (key_conflict), never answered with the first run', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('answer')])))
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'two', workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const d = await done(String(ix.id))
  const [a, b] = d.nodes
  const toA = await json(await c.post(`/api/runs/${a!.run_id}/resume`, { text: 'same words', client_request_id: 'collab-key-0001' }))
  await finishRun(toA.id)
  const again = await json(await c.post(`/api/runs/${a!.run_id}/resume`, { text: 'same words', client_request_id: 'collab-key-0001' }))
  expect(again.id).toBe(toA.id)                                                              // the same intent: the same run
  const toB = await c.post(`/api/runs/${b!.run_id}/resume`, { text: 'same words', client_request_id: 'collab-key-0001' })
  expect(toB.status).toBe(409)
  expect((await toB.json() as Record<string, unknown>).code).toBe('key_conflict')
  const chat = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'hello', client_request_id: 'collab-key-0002' }))
  await finishRun(chat.id)
  expect((await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'hello', client_request_id: 'collab-key-0002' }))).id).toBe(chat.id)
  const other = await c.post(`/api/sessions/${sid}/chat`, { text: 'another message', client_request_id: 'collab-key-0002' })
  expect(other.status).toBe(409)
}, 60_000)

test('a citation names a run and hands nothing over; a handover puts the exact answer, whole, in the opening message — both checked before anything starts', async () => {
  const { c, sid, pid } = await snapshotSession()
  const LONG = `B-ANSWER-START ${'b'.repeat(30_000)} B-ANSWER-END`
  let n = 0
  setModel(app!.state, AGENT, scriptedModel(() => { n += 1; return modelResponse([textPart(n === 1 ? 'A-SECRET-ANSWER' : n === 2 ? LONG : 'ok')]) }))
  const a = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'task A', label: 'A' } }))
  await finishRun(a.id)
  const b = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'task B', label: 'B' } }))
  await finishRun(b.id)
  let opening = ''
  setModel(app!.state, AGENT, scriptedModel((messages: ModelMessage[]) => { opening = userTexts(messages); return modelResponse([textPart('read')]) }))
  // refusals first: nothing starts
  const other = await json(await c.post(`/api/projects/${pid}/sessions`, { title: 'other', model: AGENT }))
  const foreign = await json(await c.post(`/api/sessions/${other.id}/work-orders`, { work_order: { prompt: 'elsewhere' } }))
  await finishRun(foreign.id)
  const runsBefore = repo.listRuns(app!.state.conn, sid).length
  expect((await c.post(`/api/sessions/${sid}/chat`, { text: 'x', cites: [{ run_id: foreign.id }] })).status).toBe(400)
  expect((await c.post(`/api/sessions/${sid}/chat`, { text: 'x', receive_run_ids: [foreign.id] })).status).toBe(400)
  expect((await c.post(`/api/sessions/${sid}/chat`, { text: 'x', receive_run_ids: [b.id, b.id] })).status).toBe(400)
  expect((await c.post(`/api/sessions/${sid}/chat`, { text: 'x', cites: [{ run_id: 'run_nope' }] })).status).toBe(400)
  expect((await c.post(`/api/sessions/${sid}/chat`, { text: 'x', cites: Array.from({ length: 9 }, (_, i) => ({ run_id: `run_${i}` })) })).status).toBe(422)
  expect(repo.listRuns(app!.state.conn, sid).length).toBe(runsBefore)
  const run = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'compare them', cites: [{ run_id: a.id, note: 'the first attempt' }], receive_run_ids: [b.id] }))
  await finishRun(run.id)
  expect(opening).toContain(`refers to run ${a.id}`)
  expect(opening).toContain('Its content is not in this message')
  expect(opening).not.toContain('A-SECRET-ANSWER')                                           // a citation hands nothing over
  expect(opening).toContain('B-ANSWER-START')
  expect(opening).toContain('B-ANSWER-END')                                                  // whole: past the 24,000-character packet cut
  const g = await graph(c, sid)
  const cited = g.edges.find((e) => e.kind === 'cited' && e.to.id === run.id)!
  const received = g.edges.find((e) => e.kind === 'received' && e.to.id === run.id)!
  expect(cited).toMatchObject({ from: { kind: 'run', id: a.id }, basis: 'recorded', meta: { by: 'person', note: 'the first attempt', content_delivered: false } })
  expect(received).toMatchObject({ from: { kind: 'run', id: b.id }, basis: 'recorded', meta: { via: 'dispatch', packet: 'whole', content_delivered: true } })
  expect((received.meta as { handed_chars: number }).handed_chars).toBe(LONG.length)
  // a run still going cannot be named
  const gate = new Promise<void>((r) => { release = r })
  setModel(app!.state, AGENT, scriptedModel(async () => { await gate; return modelResponse([textPart('slow')]) }))
  const slow = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'slow' } }))
  expect((await c.post(`/api/runs/${b.id}/resume`, { text: 'more', receive_run_ids: [slow.id] })).status).toBe(409)
  release()
  await finishRun(slow.id)
}, 60_000)

test('the exact answer handed over stays the run named, whatever its participant does after', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('answer')])))
  const a1 = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'A1', label: 'A' } }))
  await finishRun(a1.id)
  const handed = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'use it', receive_run_ids: [a1.id] }))
  await finishRun(handed.id)
  const a2 = await json(await c.post(`/api/runs/${a1.id}/resume`, { text: 'A2' }))
  await finishRun(a2.id)
  const g = await graph(c, sid)
  const received = g.edges.filter((e) => e.kind === 'received' && e.to.id === handed.id)
  expect(received.map((e) => e.from.id)).toEqual([String(a1.id)])
  const separate = g.participants.find((p) => p.role === 'separate')!
  expect(separate.latest_run_id).toBe(String(a2.id))                                         // the head moved; the edge did not
}, 60_000)

test('the collaboration graph: one participant per agent, a stable revision (304 while it stands), the separate task summarised in the thread with a jump to its card', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const t0 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'hello' }))
  await finishRun(t0.id)
  const wo = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'side task', label: 'lint fix' } }))
  await finishRun(wo.id)
  const g1 = await graph(c, sid)
  expect((await c.get(`/api/sessions/${sid}/collaboration`, { if_revision: g1.revision })).status).toBe(304)
  expect(g1.main_participant_id).toBe(g1.participants.find((p) => p.role === 'main')!.id)
  const separate = g1.participants.find((p) => p.role === 'separate')!
  expect(separate.label).toBe('lint fix')
  const item = g1.thread_items.find((t) => t.kind === 'dispatch')!
  expect(item).toMatchObject({ anchor: { kind: 'run', id: t0.id }, counts: { done: 1, total: 1 } })
  expect((item as { entries: { focus: unknown }[] }).entries[0]!.focus).toEqual({ participant_id: separate.id, run_id: wo.id })
  const detail = await json(await c.get(`/api/sessions/${sid}`))
  expect(detail.collaboration_revision).toBe(g1.revision)
  expect(detail.main_participant_id).toBe(g1.main_participant_id)
  expect((detail.runs as Record<string, unknown>[]).map((r) => r.id)).toEqual([t0.id])
  const rc = await json(await c.get(`/api/runs/${wo.id}/collaboration`))
  expect((rc.participant as Record<string, unknown>).id).toBe(separate.id)
  const pd = await json(await c.get(`/api/participants/${separate.id}`))
  expect((pd.runs as Record<string, unknown>[]).map((r) => r.id)).toEqual([wo.id])
  const t1 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'again' }))
  await finishRun(t1.id)
  expect((await graph(c, sid)).revision).not.toBe(g1.revision)
  // the same rows give the same graph
  const a = await graph(c, sid)
  const b = await graph(c, sid)
  expect(JSON.stringify(a)).toBe(JSON.stringify(b))
}, 60_000)

test('a message to a participant: the head it was sent against must still be its head (head_moved), and the run is that participant\'s next', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const wo = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'side task', label: 'side' } }))
  await finishRun(wo.id)
  const pidOf = String((wo.collab as Record<string, unknown>).participant_id)
  const moved = await c.post(`/api/participants/${pidOf}/messages`, { text: 'next', expected_head_run_id: 'run_other' })
  expect(moved.status).toBe(409)
  expect(((await moved.json()) as Record<string, unknown>).code).toBe('head_moved')
  const next = await json(await c.post(`/api/participants/${pidOf}/messages`, { text: 'next', expected_head_run_id: wo.id }))
  await finishRun(next.id)
  expect(next.resumes_run_id).toBe(wo.id)
  expect((next.collab as Record<string, unknown>).participant_id).toBe(pidOf)
  // the main agent before any run of it: a first thread message
  const g = await graph(c, sid)
  const first = await json(await c.post(`/api/participants/${g.main_participant_id}/messages`, { text: 'hello thread' }))
  await finishRun(first.id)
  expect((first.collab as Record<string, unknown>).participant_role).toBe('main')
}, 60_000)

test('a member\'s follow-up runs beside the thread: it does not take the composer, words steered to it reach it alone, and it holds no watch', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'two', workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const d = await done(String(ix.id))
  const gate = new Promise<void>((r) => { release = r })
  setModel(app!.state, AGENT, scriptedModel(async (messages: ModelMessage[]) => {
    if (userTexts(messages).includes('SLOW-FOLLOWUP')) await gate
    return modelResponse([textPart('ok')])
  }))
  const fu = await json(await c.post(`/api/runs/${d.nodes[0]!.run_id}/resume`, { text: 'SLOW-FOLLOWUP' }))
  await sleep(100)
  const detail = await json(await c.get(`/api/sessions/${sid}`))
  expect(detail.active_run).toBeNull()                                                       // the thread is free
  expect((detail.active_runs as Record<string, unknown>[]).map((r) => [r.id, r.participant_role, r.surface])).toEqual([[fu.id, 'member', 'group']])
  const steer = await json<{ run_id: string; steer: { status: string } }>(await c.post(`/api/runs/${fu.id}/steer`, { text: 'faster', client_request_id: 'steer-key-0001' }))
  expect([steer.run_id, steer.steer.status]).toEqual([String(fu.id), 'queued'])         // the member's own run takes them
  expect((await json(await c.get(`/api/sessions/${sid}`))).active_run).toBeNull()             // the thread stays free
  const thread = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'meanwhile' }))
  await finishRun(thread.id)
  expect((thread.collab as Record<string, unknown> | undefined)?.participant_role ?? repo.getRun(app!.state.conn, String(thread.id))!.status).toBeTruthy()
  // the same participant cannot speak twice at once
  const twice = await c.post(`/api/runs/${d.nodes[0]!.run_id}/resume`, { text: 'again' })
  expect(twice.status).toBe(409)
  release()
  await finishRun(fu.id)
}, 60_000)

test('a follow-up is refused while its interaction\'s director plans or decides; an ended one starts only the follow-up; a director\'s follow-up is not counted in the budget', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'two', participants: [{ model: AGENT, id: 'A' }, { model: AGENT, id: 'B' }], plan: { nodes: [
    { id: 'a1', participant: 'A', depends_on: [], receives: [], workspace: 'own' }, { id: 'b1', participant: 'B', depends_on: [], receives: [], workspace: 'own' },
  ], then: 'stop' }, max_runs: 4 }))
  void ix
  const ixDone = await done(String(ix.id))
  const a = ixDone.nodes.find((n) => n.id === 'a1')!
  // the director plans: a follow-up waits
  repo.updateInteraction(app!.state.conn, ixDone.id, { status: 'planning' })
  expect((await c.post(`/api/runs/${a.run_id}/resume`, { text: 'now?' })).status).toBe(409)
  repo.updateInteraction(app!.state.conn, ixDone.id, { status: 'deciding' })
  expect((await c.post(`/api/runs/${a.run_id}/resume`, { text: 'now?' })).status).toBe(409)
  // stopped with a step still queued: the follow-up alone starts; the queued step and the status stay
  repo.insertNode(app!.state.conn, { interaction_id: ixDone.id, id: 'later', participant: 'B', instruction: null, depends_on: [], receives: [], workspace: 'own', revision: 2 })
  repo.updateInteraction(app!.state.conn, ixDone.id, { status: 'cancelled', reason: 'stopped by the person' })
  const fu = await json(await c.post(`/api/runs/${a.run_id}/resume`, { text: 'one more thing' }))
  await finishRun(fu.id)
  await sleep(100)
  expect(repo.getInteraction(app!.state.conn, ixDone.id)!.status).toBe('cancelled')
  expect(repo.getNode(app!.state.conn, ixDone.id, 'later')!.status).toBe('queued')
  expect(repo.getNode(app!.state.conn, ixDone.id, 'fu-1')!.status).toBe('done')
  // a director's follow-up: not counted in the budget (4, with the plan's two runs and a step queued, the person's
  // follow-up not counted either) — it starts, and the count stays the plan's
  const ds = dstore.insertDirectorSession(app!.state.conn, { session_id: sid, transport: 'native', model: AGENT, label: 'director', config: {} })
  const turn = dstore.insertTurn(app!.state.conn, { director_session_id: ds.id, session_id: sid, kind: 'user', input: 'follow up' })
  const headers = { 'x-oasis-director-session-id': ds.id, 'x-oasis-director-turn-id': turn.id, 'x-oasis-director-tool-call-id': 'call-1' }
  const asked = await json(await c.request('POST', `/api/runs/${fu.id}/resume`, { json: { text: 'director asks' }, headers }))
  await finishRun(asked.id)
  expect(repo.getInteraction(app!.state.conn, ixDone.id)!.runs_started).toBe(2)
  expect(repo.getInteraction(app!.state.conn, ixDone.id)!.budget.max_runs).toBe(4)
  // a forged director context is refused, never read as the person
  expect((await c.request('POST', `/api/runs/${fu.id}/resume`, { json: { text: 'x' }, headers: { ...headers, 'x-oasis-director-turn-id': 'dt_forged' } })).status).toBe(400)
}, 60_000)

test('a director\'s dispatch is recorded as its turn\'s, with the dispatched edge; a director may not reach a session it holds no authority over', async () => {
  const { c, sid, pid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const ds = dstore.insertDirectorSession(app!.state.conn, { session_id: sid, transport: 'native', model: AGENT, label: 'director', config: {} })
  const turn = dstore.insertTurn(app!.state.conn, { director_session_id: ds.id, session_id: sid, kind: 'user', input: 'go' })
  const headers = { 'x-oasis-director-session-id': ds.id, 'x-oasis-director-turn-id': turn.id, 'x-oasis-director-tool-call-id': 'call-7', 'x-oasis-tool-surface': 'director.v2' }
  const sep = await json(await c.request('POST', `/api/sessions/${sid}/work-orders`, { json: { work_order: { prompt: 'separate' }, workspace_policy: 'isolated' }, headers }))
  await finishRun(sep.id)
  expect(sep.collab).toMatchObject({ participant_role: 'separate', origin: { actor: 'director', request: 'separate', director_turn_id: turn.id, tool_call_id: 'call-7', basis: 'recorded' }, placement: { surface: 'card', anchor: { kind: 'director_turn', id: turn.id } } })
  const g = await graph(c, sid)
  expect(g.edges.find((e) => e.kind === 'dispatched' && e.to.id === sep.id)).toMatchObject({ from: { kind: 'director_turn', id: turn.id }, meta: { tool_call_id: 'call-7' } })
  const other = await json(await c.post(`/api/projects/${pid}/sessions`, { title: 'other', model: AGENT }))
  expect((await c.request('POST', `/api/sessions/${other.id}/chat`, { json: { text: 'x' }, headers })).status).toBe(403)
  dstore.updateDirectorSession(app!.state.conn, ds.id, { config: { authorized_session_ids: [String(other.id)] } })
  const allowed = await json(await c.request('POST', `/api/sessions/${other.id}/chat`, { json: { text: 'x' }, headers }))
  await finishRun(allowed.id)
  expect((allowed.collab as Record<string, unknown> | undefined) ?? repo.getRun(app!.state.conn, String(allowed.id))).toBeTruthy()
}, 60_000)

test('an isolated work order over a direct folder works on an output folder of its own with the folder read-only; without the policy it works in the folder as before', async () => {
  const { c, sid, ws } = await directSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const isolated = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'isolated' }, workspace_policy: 'isolated' }))
  await finishRun(isolated.id)
  const own = repo.getWorkspace(app!.state.conn, String(isolated.workspace_id))!
  expect(own.id).not.toBe(ws)
  expect(own.source_mount?.readonly).toBe(true)
  const legacy = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'legacy' } }))
  await finishRun(legacy.id)
  expect(legacy.workspace_id).toBe(ws)
  const g = await graph(c, sid)
  expect(g.edges.find((e) => e.kind === 'workspace' && e.to.id === isolated.id)).toMatchObject({ meta: { mode: 'source_mount' } })
  expect(g.edges.find((e) => e.kind === 'workspace' && e.to.id === legacy.id)).toMatchObject({ meta: { mode: 'session_folder' } })
}, 60_000)

test('a relay member\'s follow-up keeps its identity, never advances the relay, and the thread goes on from the relay\'s last turn', async () => {
  const { c, sid } = await snapshotSession()
  const B = 'scripted:b'
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('A turn')])))
  setModel(app!.state, B, scriptedModel(() => modelResponse([textPart('B turn')])))
  const first = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'relay please', agents: [{ model: AGENT }, { model: B }] }))
  await until(() => repo.getRelay(app!.state.conn, String(first.relay_id))!, (r) => r.status === 'done')
  const relayRuns = repo.listRunsOfRelay(app!.state.conn, String(first.relay_id))
  const fu = await json(await c.post(`/api/runs/${relayRuns[0]!.id}/resume`, { text: 'A, privately' }))
  await finishRun(fu.id)
  const row = repo.getRun(app!.state.conn, String(fu.id))!
  expect(row.relay_id).toBeNull()
  expect(repo.listRunsOfRelay(app!.state.conn, String(first.relay_id))).toHaveLength(2)        // nothing advanced
  const g = await graph(c, sid)
  expect(g.runs.find((r) => r.id === fu.id)!.collab.participant_id).toBe(g.runs.find((r) => r.id === relayRuns[0]!.id)!.collab.participant_id)
  const next = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'thread again' }))
  await finishRun(next.id)
  expect(next.resumes_run_id).toBe(relayRuns[1]!.id)                                         // the relay's last turn, not A's private follow-up
}, 60_000)

test('a conversation keeps its tool list: a later run is given exactly the list its first run had, and a tool its order no longer allows is refused at the call', async () => {
  const { c, sid } = await snapshotSession()
  const seen: string[][] = []
  const descriptions: string[] = []
  let step = 0
  let refused: unknown = null
  setModel(app!.state, AGENT, scriptedModel((messages, info) => {
    seen.push(info.function_tools.map((t) => t.name))
    descriptions.push(info.function_tools.find((t) => t.name === 'read_file')?.description ?? '')
    step += 1
    if (step === 3) return modelResponse([toolCallPart('write_file', { path: 'X.md', content: 'x' }, 'w1')])
    if (step === 4) { refused = JSON.stringify(messages.at(-1)); return modelResponse([textPart('refused, fine')]) }
    return modelResponse([textPart('ok')])
  }))
  const wo = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'first', tools: ['read_file', 'write_file'] } }))
  await finishRun(wo.id)
  // the stored list is the conversation's; a later run is given it byte for byte, whatever the registry says now
  const conv = crepo.getConversation(app!.state.conn, String((wo.collab as Record<string, unknown>).conversation_id))!
  expect(conv.tool_snapshot!.names).toEqual(['read_file', 'write_file'])
  const pinned = { ...conv.tool_snapshot!, rows: conv.tool_snapshot!.rows.map((r) => (r.name === 'read_file' ? { ...r, description: 'PINNED DESCRIPTION OF AN EARLIER BUILD' } : r)) }
  // Model an earlier build consistently: its persisted function rows and request fingerprint describe the same
  // surface, and it predates provider frames. Leaving today's provider_frame beside altered old rows would test
  // a contradictory database, not replay of that earlier build's actual request.
  delete (pinned as unknown as Record<string, unknown>).provider_frame
  const { schemaRowsFingerprint } = await import('../src/llm/usage.ts')
  pinned.sha256 = schemaRowsFingerprint(pinned.rows)
  repo.setRunManifest(app!.state.conn, String(wo.id), { ...repo.getRun(app!.state.conn, String(wo.id))!.manifest, tool_schema_sha256: pinned.sha256 })
  app!.state.conn.run('UPDATE model_requests SET tool_schema_sha256=? WHERE run_id=?', [pinned.sha256.slice(0, 16), String(wo.id)])
  app!.state.conn.run('UPDATE conversations SET tool_snapshot_json=? WHERE id=?', [JSON.stringify(pinned), conv.id])
  const second = await json(await c.post(`/api/runs/${wo.id}/resume`, { text: 'second' }))
  await finishRun(second.id)
  expect(seen[1]).toEqual(seen[0]!)
  expect(descriptions[1]).toBe('PINNED DESCRIPTION OF AN EARLIER BUILD')
  // narrowed: write_file stays listed, its call is refused
  const narrowed = await json(await c.post(`/api/runs/${second.id}/resume`, { text: 'third', work_order: { tools: ['read_file'] } }))
  await finishRun(narrowed.id)
  expect(seen[2]).toEqual(seen[0]!)
  expect(String(refused)).toContain('not_allowed_now')
}, 60_000)

test('an older conversation goes on with the tools its record lists, rebuilt and proven by its fingerprint; one whose list cannot be proven is refused, never given a list made up now', async () => {
  const { c, sid } = await snapshotSession()
  const seen: string[][] = []
  setModel(app!.state, AGENT, scriptedModel((_m, info) => { seen.push(info.function_tools.map((t) => t.name)); return modelResponse([textPart('ok')]) }))
  const t0 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'hello' }))
  await finishRun(t0.id)
  // make it a pre-v25 row: no collab rows, a manifest listing two tools only, fingerprinted as the baseline sent them
  const conn = app!.state.conn
  conn.run('DELETE FROM run_collab WHERE run_id=?', [String(t0.id)])
  conn.run('DELETE FROM conversations WHERE session_id=?', [sid])
  conn.run('DELETE FROM participants WHERE session_id=?', [sid])
  const manifest = repo.getRun(conn, String(t0.id))!.manifest
  const baseline = (await import('../src/agent/surfaces/agent.v1.json')).default as { rows: { name: string; description: string; parameters: Record<string, unknown> }[] }
  const { schemaRowsFingerprint } = await import('../src/llm/usage.ts')
  const two = baseline.rows.filter((r) => r.name === 'read_file' || r.name === 'bash')
  repo.setRunManifest(conn, String(t0.id), { ...manifest, tools: ['bash', 'read_file'], tool_schema_sha256: schemaRowsFingerprint(two) })
  // Its actual request used those same two definitions; both pre-v25 evidence records must agree.
  conn.run('UPDATE model_requests SET tool_schema_sha256=? WHERE run_id=?', [schemaRowsFingerprint(two).slice(0, 16), String(t0.id)])
  const t1 = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'again' }))
  await finishRun(t1.id)
  expect(t1.resumes_run_id).toBe(String(t0.id))
  expect(seen.at(-1)).toEqual(two.map((r) => r.name))                                       // exactly those, in the order they were sent
  const conv = crepo.getConversation(conn, String((t1.collab as Record<string, unknown>).conversation_id))!
  expect(conv.tool_snapshot!.basis).toBe('reconstructed')
  // the projected participant kept its id when the new run joined it
  const g = await graph(c, sid)
  expect(g.runs.find((r) => r.id === t0.id)!.collab).toMatchObject({ participant_id: g.main_participant_id, basis: 'projected' })
  expect(g.runs.find((r) => r.id === t1.id)!.collab).toMatchObject({ participant_id: g.main_participant_id, basis: 'recorded', conversation_id: g.runs.find((r) => r.id === t0.id)!.collab.conversation_id })

  // another older conversation whose record matches nothing this build has on record: refused, nothing written
  const { c: c2, sid: sid2 } = { c, sid: String((await json(await c.post(`/api/projects/${String((await json(await c.get(`/api/sessions/${sid}`))).project_id)}/sessions`, { title: 'other', model: AGENT }))).id) }
  const u0 = await json(await c2.post(`/api/sessions/${sid2}/chat`, { text: 'hello' }))
  await finishRun(u0.id)
  conn.run('DELETE FROM run_collab WHERE run_id=?', [String(u0.id)])
  conn.run('DELETE FROM conversations WHERE session_id=?', [sid2])
  conn.run('DELETE FROM participants WHERE session_id=?', [sid2])
  repo.setRunManifest(conn, String(u0.id), { ...repo.getRun(conn, String(u0.id))!.manifest, tools: ['read_file', 'bash'], tool_schema_sha256: 'an earlier build' })
  const runsBefore = repo.listRuns(conn, sid2).length
  const refused = await c2.post(`/api/sessions/${sid2}/chat`, { text: 'again' })
  expect(refused.status).toBe(409)
  const body = await json(refused, 409)
  expect(body.code).toBe('tool_surface_unrecoverable')
  expect(String(body.detail)).toContain('fresh: true')
  expect(repo.listRuns(conn, sid2).length).toBe(runsBefore)
  expect(crepo.listConversations(conn, sid2)).toHaveLength(0)
  // the explicit way on: a new conversation (no history), its own list
  const fresh = await json(await c2.post(`/api/sessions/${sid2}/chat`, { text: 'start over', fresh: true }))
  await finishRun(fresh.id)
  expect(fresh.resumes_run_id).toBeNull()
}, 60_000)

test('a participant keeps its id across a restart, and its follow-up after the restart is still its interaction\'s step', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'two', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'independent' } }))
  const d = await done(String(ix.id))
  const before = await graph(c, sid)
  const settings = app!.state.settings
  await app!.close()
  app = await makeApp(settings)
  setModel(app.state, AGENT, scriptedModel(() => modelResponse([textPart('after restart')])))
  const c2 = new Client(app)
  const after = await graph(c2, sid)
  expect(after.participants.map((p) => p.id).sort()).toEqual(before.participants.map((p) => p.id).sort())
  const fu = await json(await c2.post(`/api/runs/${d.nodes[1]!.run_id}/resume`, { text: 'after restart' }))
  await waitDone(app.state, String(fu.id))
  expect(repo.getRun(app.state.conn, String(fu.id))!.interaction_id).toBe(String(ix.id))
  expect((await graph(c2, sid)).runs.find((r) => r.id === fu.id)!.collab.participant_id).toBe(before.runs.find((r) => r.id === d.nodes[1]!.run_id)!.collab.participant_id)
}, 60_000)

test('a step that receives another records the exact run handed, and its wait as an after edge', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('answer')])))
  const ix = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: 'discuss', workspace_policy: 'isolated', participants: [{ model: AGENT }, { model: AGENT }], plan: { template: 'discussion', cross_rounds: 1 } }))
  const d = await done(ix.id)
  const g = await graph(c, sid)
  const cross = d.nodes.filter((n) => n.id.startsWith('cross-'))
  for (const n of cross) {
    const received = g.edges.filter((e) => e.kind === 'received' && e.to.id === n.run_id)
    expect(received).toHaveLength(1)
    const from = d.nodes.find((x) => x.id === n.receives[0])!
    expect(received[0]).toMatchObject({ from: { id: from.run_id }, basis: 'recorded', meta: { via: 'node_receives', packet: 'whole', node: from.id, content_delivered: true } })
    expect(g.edges.filter((e) => e.kind === 'after' && e.to.id === n.run_id).map((e) => e.from.id).sort()).toEqual(n.depends_on.map((dep) => d.nodes.find((x) => x.id === dep)!.run_id!).sort())
  }
  const run = repo.getRun(app!.state.conn, cross[0]!.run_id!) as Run
  expect(run.interaction_id).toBe(ix.id)
}, 60_000)

test('an older follow-up that lost its interaction (the P1 orphan) is continued as that participant\'s step: its projected id is kept, its rows untouched', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('ok')])))
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'two', participants: [{ model: AGENT, id: 'A' }, { model: AGENT, id: 'B' }], plan: { template: 'independent' } }))
  const d = await done(String(ix.id))
  const a = d.nodes.find((n) => n.participant === 'A')!
  const fu = await json(await c.post(`/api/runs/${a.run_id}/resume`, { text: 'private word' }))
  await finishRun(fu.id)
  // make it the pre-v25 shape: no interaction on the row, no step, no v25 rows (what the baseline wrote)
  const conn = app!.state.conn
  conn.run('UPDATE runs SET interaction_id=NULL, interaction_node=NULL WHERE id=?', [String(fu.id)])
  conn.run("DELETE FROM interaction_nodes WHERE interaction_id=? AND kind='followup'", [String(ix.id)])
  for (const table of ['run_collab', 'collab_edges', 'conversations', 'participants']) conn.run(`DELETE FROM ${table} WHERE session_id=?`, [sid])
  const orphanRow = JSON.stringify(conn.get('SELECT * FROM runs WHERE id=?', [String(fu.id)]))
  const g0 = await graph(c, sid)
  const orphan = g0.runs.find((r) => r.id === fu.id)!.collab
  expect(orphan).toMatchObject({ participant_id: g0.runs.find((r) => r.id === a.run_id)!.collab.participant_id, participant_role: 'member', basis: 'projected', placement: { surface: 'group' } })
  expect((await json(await c.get(`/api/sessions/${sid}`))).runs as Record<string, unknown>[]).not.toContainEqual(expect.objectContaining({ id: fu.id }))
  const next = await json(await c.post(`/api/runs/${fu.id}/resume`, { text: 'and again' }))
  await finishRun(next.id)
  const row = repo.getRun(conn, String(next.id))!
  expect(row.interaction_id).toBe(String(ix.id))
  expect(repo.getNode(conn, String(ix.id), row.interaction_node!)!.depends_on).toEqual([a.id])   // after the nearest step up its chain
  expect((next.collab as Record<string, unknown>).participant_id).toBe(orphan.participant_id)
  expect((next.collab as Record<string, unknown>).conversation_id).toBe(orphan.conversation_id)
  expect(crepo.getParticipant(conn, orphan.participant_id!)).toMatchObject({ role: 'member', alias: 'A', group_kind: 'interaction', group_id: String(ix.id) })
  expect(JSON.stringify(conn.get('SELECT * FROM runs WHERE id=?', [String(fu.id)]))).toBe(orphanRow)  // the older row as it was
}, 60_000)

test('a step the person adds may name exact runs: cites (named, nothing handed) and receive_runs (the answer handed whole), checked when the step is added', async () => {
  const { c, sid } = await snapshotSession()
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('SIDE-ANSWER-TEXT')])))
  const side = await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'side', label: 'side' } }))
  await finishRun(side.id)
  setModel(app!.state, AGENT, scriptedModel(() => modelResponse([textPart('step')])))
  const ix = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: 'two', participants: [{ model: AGENT, id: 'A' }, { model: AGENT, id: 'B' }], plan: { template: 'independent' } }))
  await done(ix.id)
  expect((await c.post(`/api/interactions/${ix.id}/steps`, { nodes: [{ id: 'bad', participant: 'A', depends_on: [], receives: [], workspace: 'own', receive_runs: ['run_nope'] }] })).status).toBe(400)
  let opening = ''
  setModel(app!.state, AGENT, scriptedModel((messages: ModelMessage[]) => { opening = userTexts(messages); return modelResponse([textPart('synthesis')]) }))
  const grown = await json<InteractionDetail>(await c.post(`/api/interactions/${ix.id}/steps`, { nodes: [{ id: 'syn', participant: 'A', depends_on: ['a1'], receives: [], workspace: 'own', receive_runs: [side.id], cites: [side.id] }] }))
  const d = await done(grown.id)
  const syn = d.nodes.find((n) => n.id === 'syn')!
  expect(syn).toMatchObject({ receive_runs: [side.id], cites: [side.id], status: 'done' })
  expect(opening).toContain('SIDE-ANSWER-TEXT')
  const g = await graph(c, sid)
  expect(g.edges.find((e) => e.kind === 'received' && e.to.id === syn.run_id)).toMatchObject({ from: { id: side.id }, meta: { via: 'dispatch', packet: 'whole' } })
  expect(g.edges.find((e) => e.kind === 'cited' && e.to.id === syn.run_id)).toMatchObject({ from: { id: side.id }, meta: { content_delivered: false } })
  expect(g.nodes.find((n) => n.id === `${ix.id}/syn`)).toMatchObject({ receive_runs: [side.id], cites: [side.id], kind: 'plan' })
}, 60_000)
