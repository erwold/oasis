/** POST /api/sessions/:id/share-snapshot/v3 (src/share/task.ts): the Agent Teams card, the turns' faces, the rail's
 *  bots, and every session of a task — synthetic rows only. */

import { afterEach, expect, test } from 'bun:test'
import {
  botOf, identityTable, mainBot, sessionBots, SHARE_LIMITS_V3, ShareSnapshotResponseSchema, ShareSnapshotV3ResponseSchema, ShareSnapshotV3Schema, shareSessionAsV2,
  shareSnapshotV3Problems, turnFaceOf, type ShareSnapshotV3Response, type Session,
} from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { saveAttachment } from '../src/api/attachments.ts'
import { sessionAgentsOf } from '../src/api/session_activity.ts'
import { railOrder } from '../src/share/task.ts'
import { recordHumanRun } from '../src/agent/human_runs.ts'
import type { App } from '../src/main.ts'
import type { AppState } from '../src/api/state.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo } from './harness.ts'
import { solidPng } from './png_fixture.ts'
import { mkdtempSync, rmSync } from 'node:fs'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

type Rec = Record<string, unknown>
const MODEL = 'scripted:a'
const req = (parts: Rec[]) => ({ kind: 'request', parts })
const resp = (parts: Rec[]) => ({ kind: 'response', parts, timestamp: new Date().toISOString() })
const user = (content: string) => ({ part_kind: 'user-prompt', content, origin: 'person' })
const text = (content: string) => ({ part_kind: 'text', content })

async function project(c: Client): Promise<string> {
  return (await json(await c.post('/api/projects', { source_path: buggyRepo() }))).id as string
}
async function session(c: Client, projectId: string, title: string, taskOf?: string): Promise<Session> {
  const s = await json(await c.post(`/api/projects/${projectId}/sessions`, { title, ...(taskOf ? { task_session_id: taskOf } : {}) }))
  return repo.getSession(app!.state.conn, s.id as string)!
}

function addRun(state: AppState, s: Session, o: { user_text: string; answer?: string; parent_run_id?: string | null; resumes_run_id?: string | null; spawned_by?: string; attachments?: unknown[]; status?: string }): string {
  const run = repo.insertRun(state.conn, {
    session_id: s.id, project_id: s.project_id, workspace_id: s.workspace_id, model: MODEL, model_config: {}, user_text: o.user_text, status: 'running', budget: {},
    parent_run_id: o.parent_run_id ?? null, resumes_run_id: o.resumes_run_id ?? null, spawned_by: o.spawned_by ?? 'human', attachments: (o.attachments ?? []) as never,
  })
  const history = JSON.stringify([req([user(o.user_text)]), resp([text(o.answer ?? `answer to ${o.user_text}`)])])
  repo.finishRun(state.conn, run.id, o.status ?? 'done', { history_json: history, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  return run.id
}

async function v3(c: Client, sessionId: string, body: Rec = {}, status = 200): Promise<ShareSnapshotV3Response> {
  const res = await c.post(`/api/sessions/${sessionId}/share-snapshot/v3`, body)
  const raw = await json(res, status)
  return status === 200 ? ShareSnapshotV3ResponseSchema.parse(raw) : raw as never
}

test('one session: V3 by default (no task), the card, the faces, the rail\'s bots; its items the V2 route\'s', async () => {
  app = await makeApp()
  const c = new Client(app)
  const s = await session(c, await project(c), 'Solo')
  const r1 = addRun(app.state, s, { user_text: 'first question' })
  addRun(app.state, s, { user_text: 'follow up', resumes_run_id: r1 })
  const child = addRun(app.state, s, { user_text: 'child task', parent_run_id: r1, spawned_by: 'agent' })
  const share = await v3(c, s.id)
  const snap = share.snapshot
  expect(snap.version).toBe(3)
  expect(snap.scope).toBe('session')
  expect(snap.options.include_task_sessions).toBe(false)
  expect(snap.sessions.length).toBe(1)
  const only = snap.sessions[0]!
  expect(only.current).toBe(true)
  expect(only.member).toBe(false)
  expect(only.bots).toEqual(sessionBots(s.id, sessionAgentsOf(app.state.conn, s.id)) as never)
  // the V2 route's items, runs (without faces) and stats, unchanged
  const v2 = ShareSnapshotResponseSchema.parse(await json(await c.post(`/api/sessions/${s.id}/share-snapshot`, {})))
  const asV2 = shareSessionAsV2(snap, only.key)!
  expect(asV2.items).toEqual(v2.snapshot.items)
  expect(asV2.runs).toEqual(v2.snapshot.runs)
  expect(asV2.version).toBe(2)
  // faces: the thread's runs as turnFace, the child as its tree row's bot (shareExport.ts's two branches)
  const tree = (await json(await c.get(`/api/sessions/${s.id}/runs/tree`))).runs as Rec[]
  const table = identityTable(tree as never, s.id)
  const collabOf = new Map(tree.map((r) => [r.id as string, r.collab]))
  const keyOf = new Map(share.selection.runs.map((r) => [r.run_id, r.key]))
  for (const run of repo.listRuns(app.state.conn, s.id)) {
    const face = only.runs.find((r) => r.key === keyOf.get(run.id))!
    const c0 = collabOf.get(run.id) as { placement: { surface: string }; participant_role: string; participant_id: string } | null
    if (c0?.placement.surface === 'thread') {
      expect({ bot: face.bot, enclosed: face.enclosed }).toEqual(turnFaceOf(table, { ...run, model: run.model, collab: c0 }, null, null, null) as never)
    } else {
      const row = tree.find((r) => r.id === run.id)!
      expect(face.bot).toBe(botOf(row as never, table) as never)
    }
  }
  expect(only.runs.find((r) => r.key === keyOf.get(child))).toBeDefined()
  // the card: the main lineage (two runs) and the child, as the outline folds them
  expect(only.team.rows.length).toBe(2)
  const main = only.team.rows.find((r) => r.runs === 2)!
  expect(main.name).toBe('Main agent')
  expect(main.bot).toBe(mainBot(s.id) as never)
  expect(main.turn).toBe(keyOf.get(repo.listRuns(app.state.conn, s.id)[1]!.id)!)
  const kid = only.team.rows.find((r) => r.runs === 1)!
  expect(kid.parent).toBe(main.key)
  expect(only.team.agents).toBe(2)
  expect(snap.limits).toEqual({ ...SHARE_LIMITS_V3 })
  // nothing of the real ids
  const body = JSON.stringify(snap)
  for (const id of [s.id, s.project_id, ...repo.listRuns(app.state.conn, s.id).map((r) => r.id)]) expect(body).not.toContain(id)
})

test('the task: every session not deleted, any project, from the first session or a member alike; the rail\'s order', async () => {
  app = await makeApp()
  const c = new Client(app)
  const pa = await project(c), pb = await project(c)
  const root = await session(c, pa, 'Root')
  const m1 = await session(c, pb, 'Member in another project', root.id)
  const m2 = await session(c, pa, 'Member two', m1.id)
  addRun(app.state, root, { user_text: 'root work' })
  addRun(app.state, m1, { user_text: 'm1 work' })
  addRun(app.state, m2, { user_text: 'm2 work' })
  const fromRoot = (await v3(c, root.id, { include_task_sessions: true })).snapshot
  const fromMember = (await v3(c, m2.id, { include_task_sessions: true })).snapshot
  expect(fromRoot.scope).toBe('task')
  expect(fromRoot.sessions.map((x) => x.title)).toEqual(fromMember.sessions.map((x) => x.title))
  const order = railOrder(repo.sessionsOfTask(app.state.conn, root.id), root.id).map((x) => x.title)
  expect(fromRoot.sessions.map((x) => x.title)).toEqual(order)
  expect(order[0]).toBe('Root')
  expect(fromRoot.sessions.map((x) => x.member)).toEqual([false, true, true])
  expect(fromMember.sessions.find((x) => x.current)!.title).toBe('Member two')
  expect(fromMember.title).toBe('Member two')
  for (const x of fromRoot.sessions) expect(x.team.rows.length).toBe(1)
  // each session's main bot is its own session's
  const byTitle = new Map([[root.title, root.id], [m1.title, m1.id], [m2.title, m2.id]])
  for (const x of fromRoot.sessions) expect(x.team.rows[0]!.bot).toBe(mainBot(byTitle.get(x.title)!) as never)
  // the selection names each run's session
  expect(new Set((await v3(c, root.id, { include_task_sessions: true })).selection.runs.map((r) => r.session)).size).toBe(3)
  // the first session deleted: the others are still the task
  expect((await c.delete(`/api/sessions/${root.id}`)).status).toBe(200)
  const after = (await v3(c, m1.id, { include_task_sessions: true })).snapshot
  expect(after.sessions.map((x) => x.title).sort()).toEqual(['Member in another project', 'Member two'])
  expect(after.sessions.every((x) => x.member)).toBe(true)
  // unchecked: this session alone
  expect((await v3(c, m1.id)).snapshot.sessions.length).toBe(1)
  // no project name or path
  const body = JSON.stringify(after)
  for (const p of [pa, pb, repo.getProject(app.state.conn, pb)!.source_path!]) expect(body).not.toContain(p)
})

test('a picture is only ever its own session\'s; one session\'s words naming another member\'s folder are masked', async () => {
  app = await makeApp()
  const c = new Client(app)
  const pa = await project(c), pb = await project(c)
  const a = await session(c, pa, 'A')
  const b = await session(c, pb, 'B', a.id)
  const mine = saveAttachment(app.state, a, solidPng(6, 6, [10, 120, 200]), 'a.png')
  const theirs = saveAttachment(app.state, b, solidPng(4, 4, [200, 0, 0]), 'b.png')
  const bDir = repo.getProject(app.state.conn, pb)!.source_path!
  addRun(app.state, a, { user_text: 'look', attachments: [mine, theirs], answer: `I read ${bDir}/calc.py for you` })
  addRun(app.state, b, { user_text: 'mine', attachments: [theirs] })
  const snap = (await v3(c, a.id, { include_task_sessions: true, include_images: true })).snapshot
  const sa = snap.sessions.find((x) => x.title === 'A')!, sb = snap.sessions.find((x) => x.title === 'B')!
  const imagesA = sa.items.filter((i) => i.kind === 'image')
  expect(imagesA.map((i) => (i as { omitted: string | null }).omitted)).toEqual([null, 'missing'])
  expect(sa.images.length).toBe(1)
  expect(sb.images.length).toBe(1)
  // both sessions number their pictures from img1: each item names its OWN session's
  expect(sa.images[0]!.key).toBe('img1')
  expect(sb.images[0]!.key).toBe('img1')
  expect(sa.images[0]!.width).toBe(6)
  expect(sb.images[0]!.width).toBe(4)
  // a cross-session reference is refused by the schema; a page document checks with its own pictures
  const bad = structuredClone(snap)
  bad.sessions.find((x) => x.title === 'B')!.images = []
  expect(ShareSnapshotV3Schema.safeParse(bad).success).toBe(false)
  expect(shareSnapshotV3Problems(bad, (k) => new Set(k === sb.key ? ['img1'] : ['img1']))).toEqual([])
  // B's project folder named in A's words is masked (A's sanitizer knows every member's folders)
  expect(JSON.stringify(sa)).not.toContain(bDir)
})

test('left out: a run excluded leaves the card\'s other rows their bots; quiescence is every session\'s; too many sessions are refused whole', async () => {
  app = await makeApp()
  const c = new Client(app)
  const p = await project(c)
  const root = await session(c, p, 'Root')
  const r1 = addRun(app.state, root, { user_text: 'main' })
  const k1 = addRun(app.state, root, { user_text: 'kid one', parent_run_id: r1, spawned_by: 'agent' })
  const k2 = addRun(app.state, root, { user_text: 'kid two', parent_run_id: r1, spawned_by: 'agent' })
  const k2b = addRun(app.state, root, { user_text: 'kid two again', resumes_run_id: k2, parent_run_id: r1, spawned_by: 'agent' })
  const whole = await v3(c, root.id)
  const cut = await v3(c, root.id, { exclude_run_ids: [k1, k2] })
  const botOfRun = (s: ShareSnapshotV3Response, runId: string) => {
    const key = s.selection.runs.find((r) => r.run_id === runId)!.key
    return s.snapshot.sessions[0]!.team.rows.find((r) => r.turn === key)
  }
  expect(botOfRun(cut, k2b)!.bot).toBe(botOfRun(whole, k2b)!.bot)
  expect(botOfRun(cut, k2b)!.runs).toBe(1)
  expect(botOfRun(cut, r1)!.bot).toBe(botOfRun(whole, r1)!.bot)
  expect(cut.snapshot.sessions[0]!.team.rows.length).toBe(2)
  expect(JSON.stringify(cut.snapshot)).not.toContain('kid one')
  // a member at work: the whole share waits
  const m = await session(c, p, 'Busy member', root.id)
  const busy = repo.insertRun(app.state.conn, { session_id: m.id, project_id: m.project_id, workspace_id: m.workspace_id, model: MODEL, model_config: {}, user_text: 'w', status: 'running', budget: {} })
  const refused = await c.post(`/api/sessions/${root.id}/share-snapshot/v3`, { include_task_sessions: true })
  expect(refused.status).toBe(409)
  const refusal = await refused.json() as Rec
  expect(refusal.code).toBe('session_active')
  expect(JSON.stringify(refusal)).not.toContain(m.id)
  // this session alone still shares
  expect((await c.post(`/api/sessions/${root.id}/share-snapshot/v3`, {})).status).toBe(200)
  repo.finishRun(app.state.conn, busy.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  // past max_sessions: refused whole (413), never cut
  for (let i = 0; i < SHARE_LIMITS_V3.max_sessions - 1; i++) {
    const s = repo.createSession(app.state.conn, p, `bulk ${i}`, MODEL)
    repo.setSessionTask(app.state.conn, s.id, root.id)
  }
  expect(repo.sessionsOfTask(app.state.conn, root.id).length).toBe(SHARE_LIMITS_V3.max_sessions + 1)
  const tooMany = await c.post(`/api/sessions/${root.id}/share-snapshot/v3`, { include_task_sessions: true })
  expect(tooMany.status).toBe(413)
  expect((await tooMany.json() as Rec).code).toBe('share_too_large')
  // exactly max_sessions: shared whole, every session in its directory
  repo.deleteSession(app.state.conn, m.id)
  const started = performance.now()
  const res = await c.post(`/api/sessions/${root.id}/share-snapshot/v3`, { include_task_sessions: true })
  const raw = await res.text()
  expect(res.status).toBe(200)
  const full = ShareSnapshotV3ResponseSchema.parse(JSON.parse(raw))
  expect(full.snapshot.sessions.length).toBe(SHARE_LIMITS_V3.max_sessions)
  console.log(`v3: ${SHARE_LIMITS_V3.max_sessions} sessions, ${raw.length} bytes, ${Math.round(performance.now() - started)} ms`)
  expect(raw.length).toBeLessThan(SHARE_LIMITS_V3.max_snapshot_bytes)
}, 120_000)

test('another project\'s folder under /tmp, named in a member\'s words under either spelling (/tmp or its /private real path): never in the task\'s file', async () => {
  app = await makeApp()
  const c = new Client(app)
  // a folder made under /tmp as given (macOS stores it by its real path, /private/tmp/…; elsewhere as /tmp/…)
  const base = mkdtempSync('/tmp/oasis-share-alias-')
  try {
    const pa = await project(c)
    const pb = (await json(await c.post('/api/projects', { source_path: buggyRepo(base) }))).id as string
    const stored = repo.getProject(app.state.conn, pb)!.source_path!
    const spelled = `${base}/userrepo`                                            // the folder as the words name it
    const other = spelled.startsWith('/private/') ? spelled.slice('/private'.length) : `/private${spelled}`
    const a = await session(c, pa, 'Member A')
    await session(c, pb, 'Member B', a.id)
    addRun(app.state, a, { user_text: `compare with ${spelled}/calc.py`, answer: `read ${other}/calc.py and ${stored}/test_calc.py` })
    const snap = (await v3(c, a.id, { include_task_sessions: true })).snapshot
    const body = JSON.stringify(snap)
    for (const p of [spelled, other, stored, base, base.replace(/^\/tmp\//, '/private/tmp/')]) expect(body).not.toContain(p)
    expect(body).toContain('compare with calc.py')
    expect(body).toContain('read calc.py and test_calc.py')
    // the frozen route (V2, this session's own folders) applies the same spellings to its own folder
    const own = repo.getProject(app.state.conn, pa)!.source_path!
    addRun(app.state, a, { user_text: `x`, answer: `mine: ${own.startsWith('/private/') ? own.slice(8) : own}/calc.py` })
    expect(JSON.stringify(await json(await c.post(`/api/sessions/${a.id}/share-snapshot`, {})))).not.toContain(own)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('participants the app names by their generated ids (two share a label): in a share by their label and place — the card\'s rows, the decision\'s candidates, a group note — never the id; the app\'s own tree as it was', async () => {
  app = await makeApp()
  const c = new Client(app)
  const s = await session(c, await project(c), 'A battle')
  const ids = ['pt_63b241', 'pt_cb9ef2', 'pt_57b110']
  const participants = [...ids.map((id) => ({ id, label: 'Fable 5.1', model: 'scripted:a' })), { id: 'D', label: 'Solo critic', model: 'scripted:b' }]
  const ix = repo.insertInteraction(app.state.conn, {
    session_id: s.id, status: 'done', user_text: 'battle it out', participants, controller: 'harness' as never, template: null, then: 'stop',
    budget: { max_runs: 4, concurrency: 1 }, run_budget: {}, base_checkpoint_id: null, fresh: false, resumes_run_id: null, thinking: null, mentions: [], attachments: [],
    director_session_id: null, client_request_id: null,
  })
  for (const [i, p] of participants.entries()) {
    repo.insertNode(app.state.conn, { interaction_id: ix.id, id: `solo-${i + 1}`, participant: p.id, instruction: null, depends_on: [], receives: [], workspace: 'own', revision: 1 })
    repo.updateNode(app.state.conn, ix.id, `solo-${i + 1}`, { status: 'done' })
  }
  const note = repo.insertInteractionNote(app.state.conn, { interaction_id: ix.id, to: ids[1]!, text: 'words for the second' })
  repo.updateInteractionNote(app.state.conn, note.id, { status: 'delivered', delivered: { [ids[1]!]: 'run_000000000001', D: 'run_000000000002' } })
  // the person's adoption of a step, as the harness records it (agent/interactions.ts): its participant by its id; and one
  // naming a participant no group lists
  const adoption = `adoption of step solo-2 (${ids[1]}, checkpoint cp_000000000abc): applied`
  recordHumanRun(app.state.conn, { session_id: s.id, project_id: s.project_id, workspace_id: s.workspace_id, label: 'adopt solo-2', kind: 'integrate', text: adoption, produced: { workspace_id: s.workspace_id } })
  recordHumanRun(app.state.conn, { session_id: s.id, project_id: s.project_id, workspace_id: s.workspace_id, label: 'adopt solo-9', kind: 'integrate', text: 'adoption of step solo-9 (pt_0f0f0f, checkpoint cp_000000000abd): applied', produced: { workspace_id: s.workspace_id } })
  // the app's own tree: unchanged (its names and the decision's candidates by id, as the app always showed them)
  const tree = (await json(await c.get(`/api/sessions/${s.id}/runs/tree`))).runs as Rec[]
  expect(tree.find((r) => r.kind === 'decision')!.label).toBe(`Your choice: keep ${ids.join(' · keep ')} · keep D · ask for a synthesis`)
  expect(tree.filter((r) => r.spawned_by === 'plan' && r.kind === 'run').map((r) => r.participant_name)).toEqual([...ids, 'Solo critic'])
  // the share
  const snap = (await v3(c, s.id)).snapshot
  const only = snap.sessions[0]!
  const decision = only.team.rows.find((r) => r.kind === 'decision')!
  expect(decision.name).toBe('Your choice: keep Fable 5.1 #1 · keep Fable 5.1 #2 · keep Fable 5.1 #3 · keep Solo critic · ask for a synthesis')
  expect(decision.bot).toBeNull()
  expect(only.team.rows.filter((r) => r.kind === 'run' && r.participant_label !== null).map((r) => [r.participant_index, r.participant_label]))
    .toEqual([[0, 'Fable 5.1 #1'], [1, 'Fable 5.1 #2'], [2, 'Fable 5.1 #3'], [3, 'Solo critic']])
  const gn = only.items.find((i) => i.kind === 'group_note') as { to: string | null; delivered_to: string[] }
  expect(gn.to).toBe('Fable 5.1 #2')
  expect(gn.delivered_to).toEqual(['Fable 5.1 #2', 'Solo critic'])
  // the adoptions: their participant by its share name (the step's own name kept); one no group lists, `a participant`
  const adoptions = only.items.filter((i) => i.kind === 'action') as { text: string | null; head: string | null; what: string }[]
  expect(adoptions.map((x) => x.text)).toEqual(['adoption of step solo-2 (Fable 5.1 #2, checkpoint [id]): applied', 'adoption of step solo-9 (a participant, checkpoint [id]): applied'])
  expect(adoptions.map((x) => x.head)).toEqual(adoptions.map((x) => x.text))
  const body = JSON.stringify(snap)
  for (const id of [...ids, 'pt_0f0f0f']) expect(body).not.toContain(id)
  expect(body).not.toMatch(/\bpt_[0-9a-f]{6}\b/)
  // the frozen route (V2) names as it always did: its group note and its adoption text keep the ids
  const v2 = await json(await c.post(`/api/sessions/${s.id}/share-snapshot`, {}))
  expect(JSON.stringify(v2)).toContain(ids[1]!)
  const v2Actions = ((v2.snapshot as { items: { kind: string; text: string | null }[] }).items).filter((i) => i.kind === 'action').map((i) => i.text)
  expect(v2Actions).toEqual(['adoption of step solo-2 (pt_cb9ef2, checkpoint [id]): applied', 'adoption of step solo-9 (pt_0f0f0f, checkpoint [id]): applied'])
})
