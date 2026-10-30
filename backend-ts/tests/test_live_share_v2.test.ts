/** Live state v2 (contract/src/live_share.ts; share/live/service.ts): links of one session or of a task, their parts
 *  shared, the task followed as it grows and shrinks, the projection budget, the pictures bound to their session, and
 *  v1 left as it was. Synthetic data only; the listener binds an ephemeral loopback port. */

import { afterEach, expect, test } from 'bun:test'
import { LIVE_SHARE_LIMITS, LIVE_SHARE_LIMITS_V2, LiveStateFrameSchema, LiveStateFrameV2Schema, ShareLinkV2ListResponseSchema, ShareLinkV2Schema, type LiveStateFrameV2 } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { saveAttachment } from '../src/api/attachments.ts'
import { capabilityMatches, capabilityOf, getLink, revokeSessionLinks, shareKey } from '../src/share/live/links.ts'
import type { App } from '../src/main.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo } from './harness.ts'
import { solidPng } from './png_fixture.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { enable, liveApp, liveRun, local, makeLink, Viewer } from './live_share_helpers.ts'
import { InlineProjector, type Projector } from '../src/share/live/projector.ts'
import { ProjectorCore } from '../src/share/live/projector_core.ts'
import { appShareSource } from '../src/share/snapshot.ts'
import { recordHumanRun } from '../src/agent/human_runs.ts'

let app: App | null = null
const viewers: Viewer[] = []
afterEach(async () => { for (const v of viewers.splice(0)) v.close(); if (app) await app.close(); app = null })

type Session = NonNullable<ReturnType<typeof repo.getSession>>
async function project(a: App): Promise<string> { return (await json(await new Client(a).post('/api/projects', { source_path: buggyRepo() }))).id as string }
async function session(a: App, projectId: string, title: string, taskOf?: string): Promise<Session> {
  const s = await json(await new Client(a).post(`/api/projects/${projectId}/sessions`, { title, ...(taskOf ? { task_session_id: taskOf } : {}) }))
  return repo.getSession(a.state.conn, s.id as string)!
}
async function linkV2(a: App, sessionId: string, body: Record<string, unknown> = {}) {
  return json<{ link: { id: string; scope: string; protocol: number; members: number }; capability: string; url: string | null }>(await local(a).post(`/api/sessions/${sessionId}/share-links/v2`, body), 201)
}
async function open(port: number, capability: string): Promise<Viewer> { const v = await Viewer.open(port, capability); viewers.push(v); return v }
const v2States = (v: Viewer): LiveStateFrameV2[] => v.frames.filter((f) => f.event === 'state').map((f) => LiveStateFrameV2Schema.parse(JSON.parse(f.data)))
const lastV2 = (v: Viewer) => v2States(v).at(-1) ?? null
const titles = (f: LiveStateFrameV2 | null) => (f ? f.snapshot.sessions.map((s) => s.title) : [])
function finishedRun(a: App, s: Session, text: string): string {
  const run = repo.insertRun(a.state.conn, { session_id: s.id, project_id: s.project_id, workspace_id: s.workspace_id, model: 'scripted:a', model_config: {}, user_text: text, status: 'running', budget: {}, attachments: [] as never })
  repo.finishRun(a.state.conn, run.id, 'done', { history_json: JSON.stringify([{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: text, origin: 'person' }] }, { kind: 'response', parts: [{ part_kind: 'text', content: `done: ${text}` }] }]), usage: {}, error: null, receipt: {}, saved_seq: 0 })
  return run.id
}

test('a v2 link of one session: its own capability domain, a v2 state with the card and the faces; a v1 link beside it stays v1', async () => {
  app = await liveApp()
  const port = await enable(app)
  const p = await project(app)
  const s = await session(app, p, 'Solo live')
  finishedRun(app, s, 'hello there')
  const v2 = await linkV2(app, s.id)
  expect(v2.link.protocol).toBe(2)
  expect(v2.link.scope).toBe('session')
  expect(v2.link.members).toBe(1)
  // the capability's domain is v2's: it never verifies as a v1 capability of the same id, nor the other way round
  const key = shareKey(app.state.settings.data_dir)!
  expect(capabilityOf(key, v2.link.id, 2)).toBe(v2.capability)
  expect(capabilityMatches(key, v2.link.id, v2.capability, 1)).toBe(false)
  expect(capabilityMatches(key, v2.link.id, capabilityOf(key, v2.link.id, 1), 2)).toBe(false)
  // the row keeps v1's three option keys; protocol and task are columns
  const row = app.state.conn.get('SELECT options_json, protocol, task_root_id FROM share_links WHERE id=?', [v2.link.id])!
  expect(Object.keys(JSON.parse(String(row.options_json))).sort()).toEqual(['exclude_run_ids', 'include_images', 'include_tool_details'])
  expect(row.protocol).toBe(2)
  expect(row.task_root_id).toBeNull()
  const v1 = await makeLink(app, s.id)
  const a = await open(port, v2.capability)
  const b = await open(port, v1.capability)
  await a.until((x) => lastV2(x) !== null)
  await b.until((x) => x.last() !== null)
  const f = lastV2(a)!
  expect(f.start).toBe('s1')
  expect(f.snapshot.version).toBe(2)
  expect(f.snapshot.scope).toBe('session')
  expect(f.snapshot.current).toBe('s1')
  const only = f.snapshot.sessions[0]!
  expect(only.title).toBe('Solo live')
  expect(only.team.rows.length).toBe(1)
  expect(only.team.rows[0]!.name).toBe('Main agent')
  expect(only.runs[0]!.bot).not.toBeNull()
  expect(only.bots.length).toBeGreaterThan(0)
  expect(LiveStateFrameSchema.parse(JSON.parse(b.frames.find((x) => x.event === 'state')!.data)).snapshot.version).toBe(1)
  expect(app.state.live_share!.producerCount).toBe(1)
  expect(app.state.live_share!.producerV2Count).toBe(1)
  expect(app.state.live_share!.partCount).toBe(1)
  // no real id reaches the viewer
  for (const id of [s.id, s.project_id, ...repo.listRuns(app.state.conn, s.id).map((r) => r.id)]) expect(JSON.stringify(f)).not.toContain(id)
  // the v2 list names both; the v1 list still answers its own shape
  const list = ShareLinkV2ListResponseSchema.parse(await json(await local(app).get(`/api/sessions/${s.id}/share-links/v2`)))
  expect(list.links.map((l) => l.protocol).sort()).toEqual([1, 2])
  expect((await local(app).get(`/api/sessions/${s.id}/share-links`)).status).toBe(200)
  // owner-only, as v1: another peer is refused
  expect((await new Client(app, { ip: '192.0.2.7' }).get(`/api/sessions/${s.id}/share-links/v2`)).status).toBe(403)
})

test('a task link: every session of the task, any project, from the first or a member; a member deleted leaves at once, the first one deleted does not end it, the last does', async () => {
  app = await liveApp()
  const port = await enable(app)
  const pa = await project(app), pb = await project(app)
  const root = await session(app, pa, 'Root')
  const m1 = await session(app, pb, 'Member B', root.id)
  const m2 = await session(app, pa, 'Member C', m1.id)
  for (const s of [root, m1, m2]) finishedRun(app, s, `work of ${s.title}`)
  const fromMember = await linkV2(app, m2.id, { include_task_sessions: true })
  const fromRoot = await linkV2(app, root.id, { include_task_sessions: true })
  expect(fromMember.link.scope).toBe('task')
  expect(fromMember.link.members).toBe(3)
  expect(getLink(app.state.conn, fromMember.link.id)!.task_root_id).toBe(root.id)
  const a = await open(port, fromMember.capability)
  const b = await open(port, fromRoot.capability)
  await a.until((x) => titles(lastV2(x)).length === 3)
  await b.until((x) => titles(lastV2(x)).length === 3)
  // one projection for both links (their outputs the same whichever was first), each link's own start
  expect(app.state.live_share!.producerV2Count).toBe(1)
  expect(app.state.live_share!.partCount).toBe(3)
  const fa = lastV2(a)!, fb = lastV2(b)!
  expect(fa.snapshot).toEqual({ ...fb.snapshot, generated_at: fa.snapshot.generated_at })
  expect(titles(fa)[0]).toBe('Root')
  expect(fa.snapshot.current).toBe(fa.snapshot.sessions[0]!.key)
  expect(fa.snapshot.sessions.find((x) => x.key === fa.start)!.title).toBe('Member C')
  expect(fb.snapshot.sessions.find((x) => x.key === fb.start)!.title).toBe('Root')
  expect(fa.snapshot.sessions.map((x) => x.member)).toEqual([false, true, true])
  const keyOfB = fa.snapshot.sessions.find((x) => x.title === 'Member B')!.key
  // a v2 link of one member reuses that member's part (no new part, its bytes the same)
  const solo = await linkV2(app, m1.id)
  const c = await open(port, solo.capability)
  await c.until((x) => lastV2(x) !== null)
  expect(app.state.live_share!.partCount).toBe(3)
  const inTask = fa.snapshot.sessions.find((x) => x.title === 'Member B')!
  const alone = lastV2(c)!.snapshot.sessions[0]!
  expect({ ...alone, key: 'x' }).toEqual({ ...inTask, key: 'x' })
  // the first session deleted: the task link goes on without it — at once, not on the next poll
  const before = v2States(a).length
  expect((await new Client(app).delete(`/api/sessions/${root.id}`)).status).toBe(200)
  await a.until((x) => v2States(x).length > before && !titles(lastV2(x)).includes('Root'), 1000)
  const after = lastV2(a)!
  expect(titles(after).sort()).toEqual(['Member B', 'Member C'])
  expect(after.snapshot.sessions.find((x) => x.title === 'Member B')!.key).toBe(keyOfB)  // keys kept
  expect(getLink(app.state.conn, fromRoot.link.id)!.revoked_at).toBeNull()
  // the link made from it: start null; current the first session left; still the person's to list, reveal, revoke
  await b.until((x) => !titles(lastV2(x)).includes('Root'))
  expect(lastV2(b)!.start).toBeNull()
  expect(lastV2(b)!.snapshot.current).toBe(lastV2(b)!.snapshot.sessions[0]!.key)
  const listed = ShareLinkV2ListResponseSchema.parse(await json(await local(app).get(`/api/sessions/${m1.id}/share-links/v2`)))
  expect(listed.links.find((l) => l.id === fromRoot.link.id)!.members).toBe(2)
  expect((await local(app).post(`/api/share-links/${fromRoot.link.id}/v2/reveal`)).status).toBe(200)
  expect((await local(app).post(`/api/share-links/${fromRoot.link.id}/reveal`)).status).toBe(200)
  // a later session of the task appears (the members' poll)
  const m3 = await session(app, pb, 'Member D', m1.id)
  finishedRun(app, m3, 'late work')
  await a.until((x) => titles(lastV2(x)).includes('Member D'))
  // the last sessions deleted: the task's links end for good
  for (const s of [m1, m2, m3]) expect((await new Client(app).delete(`/api/sessions/${s.id}`)).status).toBe(200)
  await a.until((x) => x.endedWith() !== null)
  expect(a.endedWith()).toBe('session_deleted')
  expect(getLink(app.state.conn, fromMember.link.id)!.revoked_reason).toBe('session_deleted')
  expect((await local(app).post(`/api/share-links/${fromRoot.link.id}/v2/revoke`)).status).toBe(200)
  expect(app.state.live_share!.producerV2Count).toBe(0)
}, 30_000)

test('the projection budget: v1 producers and distinct v2 parts count; a task past it is busy (nothing made), one that grows past it ends busy', async () => {
  app = await liveApp()
  const port = await enable(app)
  const p = await project(app)
  const root = await session(app, p, 'Root')
  for (let i = 1; i < LIVE_SHARE_LIMITS.max_projections; i++) await session(app, p, `M${i}`, root.id)
  const link = await linkV2(app, root.id, { include_task_sessions: true })
  // a v1 producer takes one of the eight: the task of eight no longer fits
  const solo = await session(app, p, 'Elsewhere')
  const v1 = await makeLink(app, solo.id)
  const one = await open(port, v1.capability)
  await one.until((x) => x.last() !== null)
  const refused = await Viewer.open(port, link.capability)
  expect(refused.status).toBe(503)
  expect(app.state.live_share!.producerV2Count).toBe(0)
  expect(app.state.live_share!.partCount).toBe(0)
  one.close()
  await Bun.sleep(150)                                                           // the v1 producer's idle grace
  const a = await open(port, link.capability)
  await a.until((x) => titles(lastV2(x)).length === LIVE_SHARE_LIMITS.max_projections)
  expect(app.state.live_share!.partCount).toBe(LIVE_SHARE_LIMITS.max_projections)
  // a ninth session joins: no state with a session missing — the stream ends busy, everything let go
  await session(app, p, 'M-too-many', root.id)
  await a.until((x) => x.endedWith() !== null)
  expect(a.endedWith()).toBe('busy')
  expect(app.state.live_share!.producerV2Count).toBe(0)
  expect(app.state.live_share!.partCount).toBe(0)
  expect(getLink(app.state.conn, link.link.id)!.revoked_at).toBeNull()
  expect(LIVE_SHARE_LIMITS_V2.max_part_bytes * LIVE_SHARE_LIMITS.max_projections + LIVE_SHARE_LIMITS_V2.max_envelope_bytes).toBeLessThanOrEqual(LIVE_SHARE_LIMITS.max_state_bytes)
}, 30_000)

test('pictures: a member\'s picture is served for its session only, and not once it is deleted; both sessions at work show running', async () => {
  app = await liveApp()
  const port = await enable(app)
  const pa = await project(app), pb = await project(app)
  const a = await session(app, pa, 'A')
  const b = await session(app, pb, 'B', a.id)
  const img = saveAttachment(app.state, b, solidPng(5, 5, [9, 99, 199]), 'b.png')
  const run = repo.insertRun(app.state.conn, { session_id: b.id, project_id: b.project_id, workspace_id: b.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'look', status: 'running', budget: {}, attachments: [img] as never })
  repo.finishRun(app.state.conn, run.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  const ra = liveRun(app, a, 'working in A')
  const rb = liveRun(app, b, 'working in B')
  const link = await linkV2(app, a.id, { include_task_sessions: true, include_images: true })
  const v = await open(port, link.capability)
  await v.until((x) => titles(lastV2(x)).length === 2)
  const f = lastV2(v)!
  const sb = f.snapshot.sessions.find((x) => x.title === 'B')!
  const sa = f.snapshot.sessions.find((x) => x.title === 'A')!
  expect(sa.images.length).toBe(0)
  expect(sb.images.length).toBe(1)
  expect(sa.active && sb.active).toBe(true)
  expect(sa.runs.some((r) => r.status === 'running') && sb.runs.some((r) => r.status === 'running')).toBe(true)
  const resource = sb.images[0]!.resource
  const get = (cap: string) => fetch(`http://127.0.0.1:${port}/live/api/image/${resource}`, { headers: { authorization: `Bearer ${cap}` } })
  expect((await get(link.capability)).status).toBe(200)
  // a v1 link of B never serves a v2 resource
  const v1 = await makeLink(app, b.id, { include_images: true })
  const w = await open(port, v1.capability)
  await w.until((x) => x.last() !== null)
  expect((await get(v1.capability)).status).toBe(404)
  ra.finish(); rb.drop()
  repo.finishRun(app.state.conn, rb.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  expect((await new Client(app).delete(`/api/sessions/${b.id}`)).status).toBe(200)
  expect((await get(link.capability)).status).toBe(404)
  await v.until((x) => titles(lastV2(x)).length === 1)
  // a session's link of one session ends with it (as v1); the task link of A goes on
  expect(getLink(app.state.conn, v1.id)!.revoked_reason).toBe('session_deleted')
  expect(getLink(app.state.conn, link.link.id)!.revoked_at).toBeNull()
}, 30_000)

test('revoking a session\'s links leaves the task links made from it', async () => {
  app = await liveApp()
  await enable(app)
  const p = await project(app)
  const root = await session(app, p, 'Root')
  const task = await linkV2(app, root.id, { include_task_sessions: true })
  const one = await linkV2(app, root.id)
  revokeSessionLinks(app.state.conn, root.id, 'session_deleted', new Date().toISOString())
  expect(getLink(app.state.conn, task.link.id)!.revoked_at).toBeNull()
  expect(getLink(app.state.conn, one.link.id)!.revoked_reason).toBe('session_deleted')
  expect(ShareLinkV2Schema.safeParse(task.link).success).toBe(true)
})

test('the worker thread builds v2 parts: a task of two sessions each at work, each its own runs running', async () => {
  app = await liveApp({ projector: 'worker' })
  const port = await enable(app)
  const p = await project(app)
  const a = await session(app, p, 'Worker A')
  const b = await session(app, p, 'Worker B', a.id)
  const ra = liveRun(app, a, 'busy in A')
  const rb = liveRun(app, b, 'busy in B')
  ra.emit('run_started', {})
  rb.emit('run_started', {})
  expect(app.state.live_share!.projectorKind).toBe('worker')
  const link = await linkV2(app, b.id, { include_task_sessions: true })
  const v = await open(port, link.capability)
  await v.until((x) => titles(lastV2(x)).length === 2, 15_000)
  const f = lastV2(v)!
  for (const s of f.snapshot.sessions) {
    expect(s.active).toBe(true)
    expect(s.runs.length).toBe(1)
    expect(s.runs[0]!.status).toBe('running')
  }
  expect(f.snapshot.sessions.find((x) => x.key === f.start)!.title).toBe('Worker B')
  ra.finish(); rb.finish()
  await v.until((x) => lastV2(x)!.snapshot.sessions.every((s) => s.runs[0]!.status === 'done'), 15_000)
}, 60_000)

test('a session deleted while its part was being built is never sent; a burst of events is coalesced per part', async () => {
  let state: App['state'] | null = null
  const inner = new InlineProjector(() => new ProjectorCore(appShareSource(state!)))
  let hold: string | null = null
  let release: (() => void) | null = null
  const gated: Projector = {
    kind: 'inline',
    get builds() { return inner.builds },
    project: (req) => inner.project(req),
    // the part is made first (its session still there), then held: the deletion lands between the build and its use
    async part(req) { const reply = await inner.part(req); if (req.session_id === hold) await new Promise<void>((r) => { release = r }); return reply },
    image: (req) => inner.image(req),
    close: () => inner.close(),
  }
  app = await liveApp({ projector: gated })
  state = app.state
  const port = await enable(app)
  const p = await project(app)
  const a = await session(app, p, 'Keeps')
  const b = await session(app, p, 'Goes', a.id)
  const link = await linkV2(app, a.id, { include_task_sessions: true })
  const v = await open(port, link.capability)
  await v.until((x) => titles(lastV2(x)).length === 2)
  // B changes; its next part is held after it was built; B is deleted meanwhile; then the part comes back
  hold = b.id
  finishedRun(app, b, 'one more')
  app.state.runs.sessions.publish(b.id, { seq: 1, event: 'run_finished', data: {}, run_id: 'x', cursor: null } as never)
  for (let i = 0; i < 200 && release === null; i++) await Bun.sleep(5)
  expect(release).not.toBeNull()
  expect((await new Client(app).delete(`/api/sessions/${b.id}`)).status).toBe(200)
  await v.until((x) => !titles(lastV2(x)).includes('Goes'))
  const firstWithout = v2States(v).findIndex((f) => !titles(f).includes('Goes'))
  release!()
  await Bun.sleep(100)
  // from the first state without it on, it never comes back (the held part of a deleted session is dropped)
  for (const f of v2States(v).slice(firstWithout)) expect(titles(f)).toEqual(['Keeps'])
  // a burst on A: coalesced (debounce + min interval), never one build per event
  hold = null
  const before = inner.partBuilds.get(a.id) ?? 0
  const r = liveRun(app, a, 'burst')
  for (let i = 0; i < 50; i++) r.emit('text_delta', { text: `w${i} `, start: i === 0 })
  await Bun.sleep(150)
  r.finish()
  await v.until((x) => lastV2(x)!.snapshot.sessions[0]!.runs.some((run) => run.status === 'done' && run.started_at !== null) && lastV2(x)!.snapshot.sessions[0]!.runs.length === 1)
  expect((inner.partBuilds.get(a.id) ?? 0) - before).toBeLessThanOrEqual(6)
}, 30_000)

test('a slow reader with a deleted session\'s bytes still queued is cut (nothing of it delivered); a new viewer gets the state without it', async () => {
  app = await liveApp()
  await enable(app)
  const service = app.state.live_share!
  const p = await project(app)
  const a = await session(app, p, 'Stays')
  const b = await session(app, p, 'Deleted soon', a.id)
  finishedRun(app, b, 'SECRET-OF-B-0042')
  const link = await linkV2(app, a.id, { include_task_sessions: true })
  // a stream nobody reads: its frames stay queued in the stream (the viewer is not idle)
  const res = await service.handle(new Request('http://127.0.0.1/live/api/stream', { headers: { authorization: `Bearer ${link.capability}` } }))
  expect(res.status).toBe(200)
  for (let i = 0; i < 200 && (service.status().viewers === 0 || service.producerV2Count === 0); i++) await Bun.sleep(5)
  // wait for the first state to be queued (both sessions' parts built)
  const producerFrame = () => (service as unknown as { producersV2: Map<string, { frame: unknown }> }).producersV2.values().next().value?.frame ?? null
  for (let i = 0; i < 400 && producerFrame() === null; i++) await Bun.sleep(5)
  expect(producerFrame()).not.toBeNull()
  expect(service.status().viewers).toBe(1)
  expect((await new Client(app).delete(`/api/sessions/${b.id}`)).status).toBe(200)
  // cut at once: counted out, and its queue is discarded — reading it now fails, never yields B's words
  expect(service.status().viewers).toBe(0)
  const reader = res.body!.getReader()
  let got = ''
  let failed = false
  try { for (;;) { const r = await reader.read(); if (r.done) break; got += new TextDecoder().decode(r.value) } } catch { failed = true }
  expect(failed).toBe(true)
  expect(got).not.toContain('SECRET-OF-B-0042')
  // a new viewer: the state without it
  const port = service.listeningPort!
  const w = await open(port, link.capability)
  await w.until((x) => lastV2(x) !== null)
  expect(titles(lastV2(w))).toEqual(['Stays'])
  expect(JSON.stringify(lastV2(w))).not.toContain('SECRET-OF-B-0042')
}, 30_000)

test('while the task grows, no state is sent without the new session — to a viewer already there or a new one', async () => {
  let state: App['state'] | null = null
  const inner = new InlineProjector(() => new ProjectorCore(appShareSource(state!)))
  const known = new Set<string>()
  let release: (() => void) | null = null
  const gated: Projector = {
    kind: 'inline',
    get builds() { return inner.builds },
    project: (req) => inner.project(req),
    async part(req) { if (!known.has(req.session_id)) await new Promise<void>((r) => { release = r }); return inner.part(req) },
    image: (req) => inner.image(req),
    close: () => inner.close(),
  }
  app = await liveApp({ projector: gated })
  state = app.state
  const port = await enable(app)
  const p = await project(app)
  const a = await session(app, p, 'First')
  const b = await session(app, p, 'Second', a.id)
  known.add(a.id); known.add(b.id)
  const link = await linkV2(app, a.id, { include_task_sessions: true })
  const v = await open(port, link.capability)
  await v.until((x) => titles(lastV2(x)).length === 2)
  const seen = v2States(v).length
  // a third session joins; its part is held
  await session(app, p, 'Third', a.id)
  for (let i = 0; i < 400 && release === null; i++) await Bun.sleep(5)
  expect(release).not.toBeNull()
  // the first viewer gets nothing meanwhile (a state of two would be one with a session missing)
  finishedRun(app, a, 'a change of First meanwhile')
  app.state.runs.sessions.publish(a.id, { seq: 1, event: 'run_finished', data: {}, run_id: 'x', cursor: null } as never)
  const late = await open(port, link.capability)
  await Bun.sleep(250)
  expect(v2States(v).length).toBe(seen)
  expect(late.frames.length).toBe(0)
  release!()
  await v.until((x) => titles(lastV2(x)).length === 3)
  await late.until((x) => lastV2(x) !== null)
  expect(titles(v2States(late)[0]!).length).toBe(3)
  for (const f of v2States(v).slice(seen)) expect(titles(f).length).toBe(3)
}, 30_000)

test('a part past its bound: cut with marks while items or card rows can go; past it even so, busy — never rebuilt in a loop, tried again once the session changes', async () => {
  let state: App['state'] | null = null
  const inner = new InlineProjector(() => new ProjectorCore(appShareSource(state!)))
  const counted: Projector = { kind: 'inline', get builds() { return inner.builds }, project: (r) => inner.project(r), part: (r) => inner.part(r), image: (r) => inner.image(r), close: () => inner.close() }
  // a bound a session with long metadata (many runs with long labels) cannot meet even without items
  app = await liveApp({ projector: counted, max_part_bytes: 4_000 })
  state = app.state
  const port = await enable(app)
  const p = await project(app)
  const fits = await session(app, p, 'Small enough')
  finishedRun(app, fits, 'x'.repeat(3_000))                                      // its items go, the rest fits
  const ok = await linkV2(app, fits.id)
  const v = await open(port, ok.capability)
  await v.until((x) => lastV2(x) !== null)
  const f = lastV2(v)!
  expect(f.snapshot.sessions[0]!.stats.items_truncated).toBe(true)
  expect(JSON.stringify(f.snapshot.sessions[0]).length).toBeLessThanOrEqual(4_000 + 20)
  v.close()
  const big = await session(app, p, 'Too much metadata')
  for (let i = 0; i < 40; i++) {
    const r = repo.insertRun(app.state.conn, { session_id: big.id, project_id: big.project_id, workspace_id: big.workspace_id, model: 'scripted:a', model_config: {}, user_text: `t${i}`, status: 'running', budget: {}, label: `a long label number ${i} `.repeat(5), attachments: [] as never })
    repo.finishRun(app.state.conn, r.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  }
  const link = await linkV2(app, big.id)
  const a = await open(port, link.capability)
  await a.until((x) => x.endedWith() !== null)
  expect(a.endedWith()).toBe('busy')
  expect(v2States(a).length).toBe(0)
  const builds = inner.partBuilds.get(big.id) ?? 0
  expect(builds).toBe(1)
  // unchanged: refused at once, no build
  for (let i = 0; i < 3; i++) expect((await Viewer.open(port, link.capability)).status).toBe(503)
  await Bun.sleep(200)
  expect(inner.partBuilds.get(big.id)).toBe(builds)
  expect(app.state.live_share!.partCount).toBe(0)
  // changed: tried again (and refused again, the bound still unmet)
  finishedRun(app, big, 'one more')
  const again = await open(port, link.capability)
  await again.until((x) => x.endedWith() !== null)
  expect(again.endedWith()).toBe('busy')
  expect(inner.partBuilds.get(big.id)).toBe(builds + 1)
}, 30_000)

test('a session of another project joins: every part is sanitized again under the task\'s folders before any frame is sent — the task\'s and a shared one-session link\'s', async () => {
  app = await liveApp()
  const port = await enable(app)
  const pa = await project(app), pb = await project(app)
  const bDir = repo.getProject(app.state.conn, pb)!.source_path!
  expect(bDir.startsWith('/')).toBe(true)
  const a = await session(app, pa, 'A names B')
  finishedRun(app, a, `please read ${bDir}/calc.py`)
  const solo = await linkV2(app, a.id)
  const task = await linkV2(app, a.id, { include_task_sessions: true })
  const s1 = await open(port, solo.capability)
  const t1 = await open(port, task.capability)
  await s1.until((x) => lastV2(x) !== null)
  await t1.until((x) => lastV2(x) !== null)
  // before B is of the task, its folder is no folder of A's task: shown as written
  expect(JSON.stringify(lastV2(s1))).toContain(bDir)
  const soloSeen = v2States(s1).length
  // B (another project) joins A's task
  await session(app, pb, 'B', a.id)
  await t1.until((x) => titles(lastV2(x)).length === 2)
  for (const f of v2States(t1)) if (titles(f).length === 2) expect(JSON.stringify(f)).not.toContain(bDir)
  // the one-session link shares A's part: its next state (and a new viewer's first) is the part made again
  await s1.until((x) => v2States(x).length > soloSeen || x.ended, 5000)
  for (const f of v2States(s1).slice(soloSeen)) expect(JSON.stringify(f)).not.toContain(bDir)
  const s2 = await open(port, solo.capability)
  await s2.until((x) => lastV2(x) !== null)
  for (const f of v2States(s2)) expect(JSON.stringify(f)).not.toContain(bDir)
  expect(app.state.live_share!.partCount).toBe(2)                                // A's part shared by both links, B's
}, 30_000)

test('another project\'s folder under /tmp named in a member\'s words, either spelling: never in a v2 frame (the task\'s or a one-session link\'s)', async () => {
  app = await liveApp()
  const port = await enable(app)
  const base = mkdtempSync('/tmp/oasis-live-alias-')
  try {
    const pa = await project(app)
    const pb = (await json(await new Client(app).post('/api/projects', { source_path: buggyRepo(base) }))).id as string
    const spelled = `${base}/userrepo`
    const other = spelled.startsWith('/private/') ? spelled.slice('/private'.length) : `/private${spelled}`
    const a = await session(app, pa, 'A')
    await session(app, pb, 'B', a.id)
    finishedRun(app, a, `compare with ${spelled}/calc.py and ${other}/test_calc.py`)
    const task = await linkV2(app, a.id, { include_task_sessions: true })
    const solo = await linkV2(app, a.id)
    const t = await open(port, task.capability)
    const s1 = await open(port, solo.capability)
    await t.until((x) => titles(lastV2(x)).length === 2)
    await s1.until((x) => lastV2(x) !== null)
    for (const v of [t, s1]) for (const f of v2States(v)) {
      const body = JSON.stringify(f)
      for (const p of [spelled, other, base]) expect(body).not.toContain(p)
    }
    expect(JSON.stringify(lastV2(t))).toContain('compare with calc.py and test_calc.py')
  } finally { rmSync(base, { recursive: true, force: true }) }
}, 30_000)

test('a v2 frame names participants the app names by their generated ids by their label and place — the card and the decision — never the id', async () => {
  app = await liveApp()
  const port = await enable(app)
  const a = await session(app, await project(app), 'Battle live')
  const ids = ['pt_a1b2c3', 'pt_d4e5f6']
  const ix = repo.insertInteraction(app.state.conn, {
    session_id: a.id, status: 'done', user_text: 'battle', participants: ids.map((id) => ({ id, label: 'Twin model', model: 'scripted:a' })), controller: 'harness' as never,
    template: null, then: 'stop', budget: { max_runs: 2, concurrency: 1 }, run_budget: {}, base_checkpoint_id: null, fresh: false, resumes_run_id: null, thinking: null,
    mentions: [], attachments: [], director_session_id: null, client_request_id: null,
  })
  for (const [i, id] of ids.entries()) {
    repo.insertNode(app.state.conn, { interaction_id: ix.id, id: `n${i + 1}`, participant: id, instruction: null, depends_on: [], receives: [], workspace: 'own', revision: 1 })
    repo.updateNode(app.state.conn, ix.id, `n${i + 1}`, { status: 'done' })
  }
  recordHumanRun(app.state.conn, { session_id: a.id, project_id: a.project_id, workspace_id: a.workspace_id, label: 'adopt n1', kind: 'integrate', text: `adoption of step n1 (${ids[0]}, checkpoint cp_000000000abc): applied`, produced: { workspace_id: a.workspace_id } })
  const link = await linkV2(app, a.id)
  const v = await open(port, link.capability)
  await v.until((x) => lastV2(x) !== null)
  const action = lastV2(v)!.snapshot.sessions[0]!.items.find((i) => i.kind === 'action') as { text: string | null }
  expect(action.text).toBe('adoption of step n1 (Twin model #1, checkpoint [id]): applied')
  const team = lastV2(v)!.snapshot.sessions[0]!.team
  expect(team.rows.find((r) => r.kind === 'decision')!.name).toBe('Your choice: keep Twin model #1 · keep Twin model #2 · ask for a synthesis')
  expect(team.rows.filter((r) => r.participant_label !== null).map((r) => r.participant_label)).toEqual(['Twin model #1', 'Twin model #2'])
  expect(JSON.stringify(lastV2(v))).not.toMatch(/\bpt_[0-9a-f]{6}\b/)
}, 30_000)
