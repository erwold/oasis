/** Intelligent UI end to end on the backend: an agent's present_ui (validated whole, revisions, the event the thread
 *  shows, what the provider gets back), the session's surfaces over the API (the person's values, optimistic on the
 *  revision; an action prepared — never run — with its receipt idempotent per request id), ownership (another
 *  session's run, a deleted session, no token), the transcript of an ended run, the peer packet, a reopened database. */

import { afterEach, expect, test } from 'bun:test'
import type { Session, TranscriptEntry, UiSurfaceRecord } from '@oasis-code/contract'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UiSurfaceRecordSchema } from '@oasis-code/contract'
import { peerPacket } from '../src/agent/peer_packet.ts'
import { MAX_UI_BODY_BYTES, MAX_UI_REVISIONS_PER_RUN, prepareAction, presentSurface, UiError } from '../src/agent/ui_surfaces.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { parseUiSurfaceSpec, UI_LIMITS, UI_TASK_LIMITS } from '@oasis-code/contract'
import { specOf } from '../src/agent/tools/registry.ts'
import { parametersSchema } from '../src/agent/tools/registry.ts'
import * as repo from '../src/db/repo.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import { createApp, type App } from '../src/main.ts'
import type { Settings } from '../src/config.ts'
import { Client, HEADERS, json, parseSse } from './api_harness.ts'
import { buggyRepo, collectEvents, scriptedModel, setModel, testConfig, testSettings } from './harness.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

type Rec = Record<string, unknown>

const calc = (over: Rec = {}): Rec => ({
  version: 1, surface_id: 'loan', title: 'Loan', fallback: 'A loan calculator: interest = amount × rate × years.', kind: 'native',
  initial_state: { rate: 0.05 },
  actions: [{ id: 'apply', label: 'Apply', prompt: 'Draft the loan application with these numbers.' }],
  root: 'r',
  elements: {
    r: { type: 'stack', children: ['amount', 'years', 'interest', 'go'] },
    amount: { type: 'input', props: { label: 'Amount', key: 'amount', inputType: 'number', min: 0 } },
    years: { type: 'slider', props: { label: 'Years', key: 'years', min: 1, max: 30 } },
    interest: { type: 'metric', props: { label: 'Interest', value: { op: 'multiply', args: [{ state: 'amount' }, { state: 'rate' }, { state: 'years' }] } } },
    go: { type: 'button', props: { label: 'Apply', action: 'apply' } },
  },
  ...over,
})
const SECRET_HTML = '<!doctype html><script>/* SECRET-HTML-MARKER */</script><p>chart</p>'
const page = (): Rec => ({ version: 1, surface_id: 'page', title: 'Page', fallback: 'A small page.', kind: 'html', html: SECRET_HTML, actions: [{ id: 'more', label: 'More', prompt: 'Show more.' }] })

/** A script that plays its steps in order; each step sees the messages so far. */
function playing(steps: ((messages: ModelMessage[]) => ReturnType<typeof modelResponse>)[]) {
  let n = 0
  return (messages: ModelMessage[]) => {
    const step = steps[n] ?? (() => modelResponse([textPart('done')]))
    n += 1
    return step(messages)
  }
}

async function openOverApi(c: Client): Promise<Session> {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 't', model: 'scripted:a' }))
  return repo.getSession(app!.state.conn, String(session.id))!
}

/** A run that presents the calculator (twice: revision 2 changes the title), an invalid surface, and the html page. */
async function presentingRun(c: Client, session: Session, returns: Record<string, Rec>) {
  const take = (key: string) => (m: ModelMessage[]) => { returns[key] = lastToolReturn(m, 'present_ui') as Rec }
  setModel(app!.state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('present_ui', calc(), 'u1')]),
    (m) => { take('first')(m); return modelResponse([toolCallPart('present_ui', calc({ title: 'Loan v2', initial_state: { rate: 0.05 } }), 'u2')]) },
    (m) => { take('second')(m); return modelResponse([toolCallPart('present_ui', { ...calc({ surface_id: 'bad' }), root: 'missing' }, 'u3')]) },
    (m) => { take('invalid')(m); return modelResponse([toolCallPart('present_ui', page(), 'u4')]) },
    (m) => { take('html')(m); return modelResponse([textPart('Here is the calculator.')]) },
  ])))
  const run = await app!.state.runs.start(session, 'show me a loan calculator')
  const events = await collectEvents(app!.state, run.id)
  return { run: repo.getRun(app!.state.conn, run.id)!, events }
}

test('present_ui: validated whole, revisions per surface id, a ui_surface event each, a small return without the spec', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const returns: Record<string, Rec> = {}
  const { run, events } = await presentingRun(c, session, returns)
  expect(run.status).toBe('done')
  expect(returns.first).toMatchObject({ status: 'ok', surface_id: 'loan', revision: 1, kind: 'native' })
  expect(returns.second).toMatchObject({ status: 'ok', surface_id: 'loan', revision: 2 })
  expect(returns.invalid!.status).toBe('invalid')
  expect((returns.invalid!.errors as string[]).join()).toContain('root: no element missing')
  expect(String(returns.invalid!.message)).toContain('call present_ui again')
  expect(returns.html).toMatchObject({ status: 'ok', surface_id: 'page', revision: 1, kind: 'html' })
  // what the provider reads back never carries the spec, the elements or the document
  for (const r of Object.values(returns)) {
    expect(JSON.stringify(r)).not.toContain('SECRET-HTML-MARKER')
    expect('elements' in r || 'spec' in r || 'html' in r).toBe(false)
  }
  // the events: one ui_surface per successful call, the record whole, run and session the server's
  const ui = events.filter((e) => e.event === 'ui_surface').map((e) => (e.data as { surface: UiSurfaceRecord }).surface)
  expect(ui.map((s) => [s.surface_id, s.revision])).toEqual([['loan', 1], ['loan', 2], ['page', 1]])
  for (const s of ui) {
    expect(UiSurfaceRecordSchema.safeParse(s).success).toBe(true)
    expect(s.session_id).toBe(session.id)
    expect(s.run_id).toBe(run.id)
    expect(s.model).toBe('scripted:a')
  }
  expect(ui[1]!.spec.title).toBe('Loan v2')
  expect(ui[0]!.state).toEqual({ rate: 0.05, amount: null, years: 1 })
  // the tool rows stay summaries; the invalid call's row says why
  const results = events.filter((e) => e.event === 'tool_result' && e.data.tool === 'present_ui')
  expect(results.map((e) => e.data.status)).toEqual(['ok', 'ok', 'invalid', 'ok'])
  for (const e of results) expect(JSON.stringify(e.data)).not.toContain('SECRET-HTML-MARKER')
  expect(events.filter((e) => e.event === 'tool_call' && e.data.tool === 'present_ui').map((e) => e.data.surface_id)).toEqual(['loan', 'loan', 'bad', 'page'])
  // the session's surfaces: latest revision of each, the invalid one never written
  const listed = (await json(await c.get(`/api/sessions/${session.id}/ui`))).surfaces as UiSurfaceRecord[]
  expect(listed.map((s) => [s.surface_id, s.revision])).toEqual([['loan', 2], ['page', 1]])
  // the transcript of the ended run: one 'ui' entry per surface, right after the call that first showed it
  const transcript = (await json(await c.get(`/api/runs/${run.id}/transcript`))).entries as TranscriptEntry[]
  const kinds = transcript.map((e) => (e.kind === 'activity' ? `${e.tool}:${String(e.result?.status)}` : e.kind === 'ui' ? `ui:${e.surface!.surface_id}@${e.surface!.revision}` : e.kind))
  expect(kinds).toEqual(['user', 'present_ui:ok', 'ui:loan@2', 'present_ui:ok', 'present_ui:invalid', 'present_ui:ok', 'ui:page@1', 'agent'])
  expect(transcript[1]!.result).toEqual({ status: 'ok', surface_id: 'loan', revision: 1 })
  // the persisted stream (reconnect, replay) carries the records too
  const sse = parseSse(await (await c.get(`/api/runs/${run.id}/events`, { after: -1 })).text())
  expect(sse.filter((f) => f.event === 'ui_surface').map((f) => (f.data.surface as Rec).revision)).toEqual([1, 2, 1])
  const replay = await json(await c.get(`/api/sessions/${session.id}/replay`))
  expect((replay.events as Rec[]).filter((e) => e.event === 'ui_surface')).toHaveLength(3)
  // a peer (relay, interaction, director) reads the surfaces as their words, never the document
  const packet = peerPacket(app.state.conn, run, { turn: 1, speaker: 'A' })
  expect(packet).toContain('Surfaces shown to the person (2):')
  expect(packet).toContain('[UI surface "Loan v2" (loan, revision 2, native)] A loan calculator')
  expect(packet).toContain('[UI surface "Page" (page, revision 1, html)] A small page.')
  expect(packet).not.toContain('SECRET-HTML-MARKER')
  expect(packet).toContain('[present_ui loan → ok')
})

test('the person\'s values: merged, checked, optimistic on the revision; a republish keeps them unless initial_state says otherwise', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const { run } = await presentingRun(c, session, {})
  const base = `/api/sessions/${session.id}/ui/${run.id}/loan`
  const saved = (await json(await c.put(`${base}/state`, { revision: 2, state: { amount: 1000 } }))).surface as UiSurfaceRecord
  expect(saved.state).toEqual({ rate: 0.05, amount: 1000, years: 1 })
  const again = (await json(await c.put(`${base}/state`, { revision: 2, state: { years: 10 } }))).surface as UiSurfaceRecord
  expect(again.state).toEqual({ rate: 0.05, amount: 1000, years: 10 })               // a key left out keeps its value
  // a stale revision: 409 with the surface as it stands, nothing written
  const stale = await c.put(`${base}/state`, { revision: 1, state: { years: 20 } })
  expect(stale.status).toBe(409)
  const staleBody = await stale.json() as Rec
  expect(staleBody.error).toBe('stale_revision')
  expect((staleBody.surface as UiSurfaceRecord).revision).toBe(2)
  // invalid values: 400, nothing written
  for (const state of [{ years: 99 }, { amount: 'lots' }, { nope: 1 }, { amount: -1 }, { years: { $set: 1 } }]) {
    const r = await c.put(`${base}/state`, { revision: 2, state })
    expect(r.status, JSON.stringify(state)).toBe(400)
    expect(((await r.json()) as Rec).error).toBe('invalid_state')
  }
  const protoBody = '{"revision":2,"state":{"__proto__":{"years":3}}}'
  const proto = await app.app.request(`http://localhost${base}/state`, { method: 'PUT', headers: { ...HEADERS, 'content-type': 'application/json' }, body: protoBody })
  expect(proto.status).toBe(400)
  expect(((await proto.json()) as Rec).detail).toContain('reserved')
  expect(({} as Rec).years).toBeUndefined()
  expect(repo.getUiSurface(app.state.conn, session.id, run.id, 'loan')!.state).toEqual({ rate: 0.05, amount: 1000, years: 10 })
  // a malformed or oversized body
  expect((await c.put(`${base}/state`, { revision: 'two', state: {} })).status).toBe(422)
  expect((await c.put(`${base}/state`, { revision: 2, state: {}, extra: 1 })).status).toBe(422)
  expect((await c.put(`${base}/state`, { revision: 2, state: { amount: 'x'.repeat(MAX_UI_BODY_BYTES + 1) } })).status).toBe(413)
  // html: any keys within the limits
  const html = (await json(await c.put(`/api/sessions/${session.id}/ui/${run.id}/page/state`, { revision: 1, state: { chosen: ['a', 'b'], n: 3 } }))).surface as UiSurfaceRecord
  expect(html.state).toEqual({ chosen: ['a', 'b'], n: 3 })
  expect((await c.put(`/api/sessions/${session.id}/ui/${run.id}/page/state`, { revision: 1, state: { deep: { x: 1 } } })).status).toBe(400)
  // the database holds what the API answered
  expect(repo.getUiSurface(app.state.conn, session.id, run.id, 'page')!.state).toEqual({ chosen: ['a', 'b'], n: 3 })
})

test('a republished surface keeps the person\'s values for keys initial_state leaves out, takes the ones it sets', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  let surfaceSeen: Rec | null = null
  setModel(app.state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('present_ui', calc(), 'u1')]),
    () => modelResponse([toolCallPart('watch', { kind: 'timer', delay_s: 30, note: 'x' }, 'w')]),   // a pause: the person types meanwhile
  ])))
  const run = await app.state.runs.start(session, 'calc')
  await collectEvents(app.state, run.id)
  const base = `/api/sessions/${session.id}/ui/${run.id}/loan`
  await json(await c.put(`${base}/state`, { revision: 1, state: { amount: 500, years: 7 } }))
  // the same run's presenter, called again in process (the tool is what the model calls)
  const { presentSurface } = await import('../src/agent/ui_surfaces.ts')
  const r2 = presentSurface(app.state.conn, { session_id: session.id, run_id: run.id, model: 'scripted:a' }, calc({ initial_state: { rate: 0.07, years: 3 } }))
  expect(r2.ok).toBe(true)
  surfaceSeen = (r2 as { surface: UiSurfaceRecord }).surface as unknown as Rec
  expect(surfaceSeen.revision).toBe(2)
  expect(surfaceSeen.state).toEqual({ rate: 0.07, years: 3, amount: 500 })            // amount kept; rate and years set again
  // a revision whose spec drops a key drops its value; one whose kind changes resets it
  const narrowed = calc({ elements: { r: { type: 'stack', children: ['years', 'go'] }, years: { type: 'slider', props: { label: 'Years', key: 'years', min: 10, max: 30 } }, go: { type: 'button', props: { label: 'Apply', action: 'apply' } } }, initial_state: {} })
  const r3 = presentSurface(app.state.conn, { session_id: session.id, run_id: run.id, model: 'scripted:a' }, narrowed)
  expect((r3 as { surface: UiSurfaceRecord }).surface.state).toEqual({ years: 10 })    // 3 is outside 10..30 now: the default
})

test('an action is prepared, never run: a receipt, a bounded prompt, idempotent per request id, a conflict on another payload', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const { run } = await presentingRun(c, session, {})
  const runsBefore = repo.countRuns(app.state.conn, session.id)
  const eventsBefore = repo.maxEventSeq(app.state.conn, run.id)
  const historyBefore = repo.getRunHistory(app.state.conn, run.id)
  const url = `/api/sessions/${session.id}/ui/${run.id}/loan/actions`
  const body = { revision: 2, action_id: 'apply', state: { amount: 2000, years: 5 }, request_id: 'req-0001-abc' }
  const first = await json(await c.post(url, body))
  expect(first.status).toBe('prepared')
  expect(String(first.receipt_id)).toStartWith('uia_')
  const prompt = String(first.prompt)
  expect(prompt).toContain('[UI action] "Apply" (action apply) on the surface "Loan v2" (surface loan, revision 2, from run ' + run.id + ').')
  expect(prompt).toContain('What the action asks: Draft the loan application with these numbers.')
  expect(prompt).toContain('"amount":2000')
  expect((first.surface as UiSurfaceRecord).state).toEqual({ rate: 0.05, amount: 2000, years: 5 })   // the values are saved with it
  // the same request again: the same receipt; under another payload: a conflict
  const second = await json(await c.post(url, { ...body, state: { years: 5, amount: 2000 } }))       // key order does not matter
  expect(second.receipt_id).toBe(first.receipt_id)
  expect(second.prompt).toBe(first.prompt)
  const conflict = await c.post(url, { ...body, state: { amount: 3000, years: 5 } })
  expect(conflict.status).toBe(409)
  expect(((await conflict.json()) as Rec).error).toBe('request_conflict')
  // an unknown action, a stale revision, invalid values: refused, nothing recorded
  const unknown = await c.post(url, { ...body, action_id: 'launch', request_id: 'req-0002-abc' })
  expect(unknown.status).toBe(400)
  expect(((await unknown.json()) as Rec).error).toBe('unknown_action')
  const stale = await c.post(url, { ...body, revision: 1, request_id: 'req-0003-abc' })
  expect(stale.status).toBe(409)
  expect(((await stale.json()) as Rec).error).toBe('stale_revision')
  expect((await c.post(url, { ...body, state: { years: 0 }, request_id: 'req-0004-abc' })).status).toBe(400)
  expect((await c.post(url, { ...body, request_id: 'short' })).status).toBe(422)
  expect(repo.getUiActionReceipt(app.state.conn, session.id, 'req-0002-abc')).toBeNull()
  expect(repo.getUiActionReceipt(app.state.conn, session.id, 'req-0004-abc')).toBeNull()
  // nothing ran: no run started or resumed, no event added, the conversation's record untouched
  expect(repo.countRuns(app.state.conn, session.id)).toBe(runsBefore)
  expect(repo.maxEventSeq(app.state.conn, run.id)).toBe(eventsBefore)
  expect(repo.getRunHistory(app.state.conn, run.id)).toBe(historyBefore)
  expect(app.state.runs.activeRunsOfSession(session.id)).toHaveLength(0)
  // an html surface's action too
  const html = await json(await c.post(`/api/sessions/${session.id}/ui/${run.id}/page/actions`, { revision: 1, action_id: 'more', state: { picked: 'b' }, request_id: 'req-0005-abc' }))
  expect(String(html.prompt)).toContain('"picked":"b"')
  expect(String(html.prompt)).not.toContain('SECRET-HTML-MARKER')
})

test('ownership: another session\'s run, an unknown surface, a deleted session, no token — not found or refused', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const mine = await openOverApi(c)
  const other = await openOverApi(c)
  const { run } = await presentingRun(c, mine, {})
  const state = { revision: 2, state: { amount: 1 } }
  const action = { revision: 2, action_id: 'apply', state: {}, request_id: 'req-own-0001' }
  // the run is mine: through another session it is not found, whatever the surface id
  for (const [method, path, body] of [
    ['PUT', `/api/sessions/${other.id}/ui/${run.id}/loan/state`, state], ['POST', `/api/sessions/${other.id}/ui/${run.id}/loan/actions`, action],
    ['PUT', `/api/sessions/${mine.id}/ui/${run.id}/nope/state`, state], ['PUT', `/api/sessions/${mine.id}/ui/run_000000000000/loan/state`, state],
    ['PUT', `/api/sessions/s_nope/ui/${run.id}/loan/state`, state], ['GET', '/api/sessions/s_nope/ui', undefined],
  ] as const) {
    const r = await c.request(method, path, { json: body })
    expect(r.status, `${method} ${path}`).toBe(404)
  }
  expect(((await json(await c.get(`/api/sessions/${other.id}/ui`))).surfaces as unknown[])).toEqual([])
  // no token: the session token guards these routes like every other
  const anonymous = new Client(app, { headers: { origin: 'http://localhost' } })
  expect((await anonymous.get(`/api/sessions/${mine.id}/ui`)).status).toBe(401)
  expect((await anonymous.put(`/api/sessions/${mine.id}/ui/${run.id}/loan/state`, state)).status).toBe(401)
  expect((await anonymous.post(`/api/sessions/${mine.id}/ui/${run.id}/loan/actions`, action)).status).toBe(401)
  expect(repo.getUiSurface(app.state.conn, mine.id, run.id, 'loan')!.state.amount).toBeNull()
  // a deleted session's surfaces are gone from the API (its records stay on disk)
  await json(await c.delete(`/api/sessions/${mine.id}`))
  expect((await c.get(`/api/sessions/${mine.id}/ui`)).status).toBe(404)
  expect((await c.put(`/api/sessions/${mine.id}/ui/${run.id}/loan/state`, state)).status).toBe(404)
  expect(repo.getUiSurface(app.state.conn, mine.id, run.id, 'loan')).not.toBeNull()
})

test('two agents use the same surface id in their own runs: two surfaces, own revisions, no conflict', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const presentOnce = (title: string) => scriptedModel(playing([() => modelResponse([toolCallPart('present_ui', calc({ title }), 'u1')]), () => modelResponse([textPart('ok')])]))
  setModel(app.state, 'scripted:a', presentOnce('From A'))
  setModel(app.state, 'scripted:b', presentOnce('From B'))
  const a = await app.state.runs.start(session, 'A, show it', { model_id: 'scripted:a' })
  await collectEvents(app.state, a.id)
  const b = await app.state.runs.start(repo.getSession(app.state.conn, session.id)!, 'B, show it', { model_id: 'scripted:b' })
  await collectEvents(app.state, b.id)
  const listed = (await json(await c.get(`/api/sessions/${session.id}/ui`))).surfaces as UiSurfaceRecord[]
  expect(listed.map((s) => [s.run_id, s.surface_id, s.revision, s.spec.title, s.model])).toEqual([
    [a.id, 'loan', 1, 'From A', 'scripted:a'], [b.id, 'loan', 1, 'From B', 'scripted:b'],
  ])
  await json(await c.put(`/api/sessions/${session.id}/ui/${a.id}/loan/state`, { revision: 1, state: { amount: 1 } }))
  await json(await c.put(`/api/sessions/${session.id}/ui/${b.id}/loan/state`, { revision: 1, state: { amount: 2 } }))
  const after = (await json(await c.get(`/api/sessions/${session.id}/ui`))).surfaces as UiSurfaceRecord[]
  expect(after.map((s) => s.state.amount)).toEqual([1, 2])
  // each run's transcript shows its own
  const ta = (await json(await c.get(`/api/runs/${a.id}/transcript`))).entries as TranscriptEntry[]
  expect(ta.filter((e) => e.kind === 'ui').map((e) => e.surface!.spec.title)).toEqual(['From A'])
})

test('a run presents a bounded number of revisions; Plan mode keeps present_ui; the tool schema is flat for every provider', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  await json(await c.put(`/api/sessions/${session.id}/mode`, { mode: 'plan' }))
  let last: Rec = {}
  const steps = Array.from({ length: MAX_UI_REVISIONS_PER_RUN + 1 }, (_, i) => (m: ModelMessage[]) => {
    if (i > 0) last = lastToolReturn(m, 'present_ui') as Rec
    return modelResponse([toolCallPart('present_ui', calc(), `u${i}`)])
  })
  setModel(app.state, 'scripted:a', scriptedModel(playing([...steps, (m) => { last = lastToolReturn(m, 'present_ui') as Rec; return modelResponse([textPart('done')]) }])))
  const run = await app.state.runs.start(repo.getSession(app.state.conn, session.id)!, 'show it many times', { budget: { tool_calls: 200, requests: 200 } })
  await collectEvents(app.state, run.id)
  const rec = repo.getUiSurface(app.state.conn, session.id, run.id, 'loan')!
  expect(rec.revision).toBe(MAX_UI_REVISIONS_PER_RUN)                                   // Plan mode did not block it
  expect(last.status).toBe('invalid')
  expect((last.errors as string[])[0]).toContain('revisions')
  // the parameters the model sees: no $ref / $defs (a recursive schema some providers refuse), the element types listed
  const schema = parametersSchema(specOf('present_ui')!)
  const text = JSON.stringify(schema)
  expect(text).not.toContain('$ref')
  expect(text).not.toContain('$defs')
  expect(text).toContain('"checkbox"')
  expect(specOf('present_ui')!.effect).toBe('read')
})

test('the surfaces survive the process: a reopened database serves them, their values and the transcript', async () => {
  const settings: Settings = testSettings()
  app = await createApp(settings, testConfig(), { probe: false })
  let c = new Client(app)
  const session = await openOverApi(c)
  const { run } = await presentingRun(c, session, {})
  await json(await c.put(`/api/sessions/${session.id}/ui/${run.id}/loan/state`, { revision: 2, state: { amount: 42 } }))
  const receipt = await json(await c.post(`/api/sessions/${session.id}/ui/${run.id}/loan/actions`, { revision: 2, action_id: 'apply', state: {}, request_id: 'req-reopen-1' }))
  await app.close()
  app = await createApp(settings, testConfig(), { probe: false })
  c = new Client(app)
  const listed = (await json(await c.get(`/api/sessions/${session.id}/ui`))).surfaces as UiSurfaceRecord[]
  expect(listed.map((s) => [s.surface_id, s.revision, s.state.amount ?? null])).toEqual([['loan', 2, 42], ['page', 1, null]])
  const transcript = (await json(await c.get(`/api/runs/${run.id}/transcript`))).entries as TranscriptEntry[]
  expect(transcript.filter((e) => e.kind === 'ui').map((e) => [e.surface!.surface_id, e.surface!.state.amount ?? null])).toEqual([['loan', 42], ['page', null]])
  // the receipt is still the request's: the same request answers it, another payload under it conflicts
  const again = await json(await c.post(`/api/sessions/${session.id}/ui/${run.id}/loan/actions`, { revision: 2, action_id: 'apply', state: {}, request_id: 'req-reopen-1' }))
  expect(again.receipt_id).toBe(receipt.receipt_id)
  expect((await c.post(`/api/sessions/${session.id}/ui/${run.id}/loan/actions`, { revision: 2, action_id: 'apply', state: { amount: 1 }, request_id: 'req-reopen-1' })).status).toBe(409)
})

test('a reserved key in the model\'s arguments is refused by name before the schema reads them; nothing is shown', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const poisoned = JSON.parse(JSON.stringify(calc()).replace('"initial_state":{', '"initial_state":{"__proto__":{"amount":1},'))
  expect(Object.keys(poisoned.initial_state)).toContain('__proto__')
  let retried = ''
  setModel(app.state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('present_ui', poisoned, 'p1')]),
    (m) => {
      const last = m.at(-1) as { parts: { part_kind: string; content: unknown }[] }
      retried = JSON.stringify(last.parts.filter((p) => p.part_kind === 'retry-prompt').map((p) => p.content))
      return modelResponse([textPart('ok')])
    },
  ])))
  const run = await app.state.runs.start(session, 'show it')
  const events = await collectEvents(app.state, run.id)
  expect(retried).toContain('reserved')
  expect(events.some((e) => e.event === 'ui_surface')).toBe(false)
  expect(repo.listUiSurfaces(app.state.conn, session.id)).toEqual([])
  expect(({} as Rec).amount).toBeUndefined()
})


/** A request whose body streams in chunks, with no Content-Length; `pulled` counts the bytes the server asked for. */
function streamingPut(url: string, chunk: Uint8Array, chunks: number, pulled: { bytes: number }): Request {
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) { controller.close(); return }
      sent += 1
      pulled.bytes += chunk.byteLength
      controller.enqueue(chunk)
    },
  }, { highWaterMark: 0 })
  return new Request(url, { method: 'PUT', headers: { ...HEADERS, 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit)
}

test('review 4: a body is read as it streams, up to its byte bound: a chunked one past it is cancelled; UTF-8 text is whole', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const { run } = await presentingRun(c, session, {})
  const url = `http://localhost/api/sessions/${session.id}/ui/${run.id}/page/state`
  // chunked, no length, 64 MiB on offer: refused once it passes the bound, the rest never pulled
  const pulled = { bytes: 0 }
  const chunk = new Uint8Array(64 * 1024).fill(0x20)
  const big = await app.app.request(streamingPut(url, chunk, 1024, pulled))
  expect(big.status).toBe(413)
  expect(((await big.json()) as Rec).error).toBe('too_large')
  expect(pulled.bytes).toBeLessThanOrEqual(MAX_UI_BODY_BYTES + 2 * chunk.byteLength)
  // a declared length past the bound: refused before reading
  const declared = { bytes: 0 }
  const req = streamingPut(url, chunk, 1024, declared)
  const withLength = new Request(req, { headers: { ...HEADERS, 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) } })
  expect((await app.app.request(withLength)).status).toBe(413)
  expect(declared.bytes).toBeLessThanOrEqual(chunk.byteLength)
  // a normal body in Chinese, streamed in small chunks that split characters: read whole, saved as sent
  const text = JSON.stringify({ revision: 1, state: { city: '里斯本', note: '这段解释'.repeat(500) } })
  const bytes = new TextEncoder().encode(text)
  const pieces: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += 1000) pieces.push(bytes.slice(i, i + 1000))
  let i = 0
  const zh = new ReadableStream<Uint8Array>({ pull(ctl) { if (i < pieces.length) ctl.enqueue(pieces[i++]!); else ctl.close() } })
  const ok = await app.app.request(new Request(url, { method: 'PUT', headers: { ...HEADERS, 'content-type': 'application/json' }, body: zh, duplex: 'half' } as RequestInit))
  expect(ok.status, await ok.clone().text()).toBe(200)
  expect(((await ok.json()) as { surface: UiSurfaceRecord }).surface.state).toEqual({ city: '里斯本', note: '这段解释'.repeat(500) })
  // bytes that are not UTF-8
  const bad = await app.app.request(new Request(url, { method: 'PUT', headers: { ...HEADERS, 'content-type': 'application/json' }, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }))
  expect(bad.status).toBe(422)
})

test('review 5: the action service bounds its input before hashing it; a seen request answers before the revision is checked', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const { run } = await presentingRun(c, session, {})
  let deep: unknown = 1
  for (let i = 0; i < 10_000; i += 1) deep = [deep]
  let caught: unknown = null
  try { prepareAction(app.state.conn, session.id, run.id, 'loan', { revision: 2, action_id: 'apply', state: { amount: deep } as Rec, request_id: 'req-deep-0001' }) } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(UiError)
  expect((caught as UiError).status).toBe(400)
  expect(repo.getUiActionReceipt(app.state.conn, session.id, 'req-deep-0001')).toBeNull()
  // a receipt made at revision 2 is still the request's answer after the agent presents revision 3
  const body = { revision: 2, action_id: 'apply', state: { amount: 7 }, request_id: 'req-retry-0001' }
  const first = prepareAction(app.state.conn, session.id, run.id, 'loan', body)
  expect(presentSurface(app.state.conn, { session_id: session.id, run_id: run.id, model: 'scripted:a' }, calc({ title: 'Loan v3' })).ok).toBe(true)
  const again = await json(await c.post(`/api/sessions/${session.id}/ui/${run.id}/loan/actions`, body))
  expect(again.receipt_id).toBe(first.receipt_id)
  expect((again.surface as UiSurfaceRecord).revision).toBe(3)                             // with the surface as it stands
  const other = await c.post(`/api/sessions/${session.id}/ui/${run.id}/loan/actions`, { ...body, state: { amount: 8 } })
  expect(other.status).toBe(409)
  expect(((await other.json()) as Rec).error).toBe('request_conflict')
  const fresh = await c.post(`/api/sessions/${session.id}/ui/${run.id}/loan/actions`, { ...body, request_id: 'req-retry-0002' })
  expect(((await fresh.json()) as Rec).error).toBe('stale_revision')                     // a new request meets the revision check
})

test('review 6: a surface reloads where it ran — after its response\'s words — whatever the order of the parts, at its latest revision', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  setModel(app.state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('present_ui', calc(), 'u1'), textPart('这段解释')]),                                   // tool, then words
    () => modelResponse([textPart('再看这个'), toolCallPart('present_ui', page(), 'u2')]),                                     // words, then tool
    () => modelResponse([toolCallPart('present_ui', calc({ title: 'Loan v2' }), 'u3')]),                                       // revision 2
    () => modelResponse([textPart('完成')]),
  ])))
  const run = await app.state.runs.start(session, 'show')
  const events = await collectEvents(app.state, run.id)
  // live: the order the thread showed
  const live = events.flatMap((e) => {
    if (e.event === 'text_block') return [`text:${String(e.data.text)}`]
    if (e.event === 'tool_call' && e.data.tool === 'present_ui') return [`call:${String(e.data.tool_call_id)}`]
    if (e.event === 'ui_surface') {
      const s = (e.data as { surface: UiSurfaceRecord }).surface
      return s.revision === 1 ? [`ui:${s.surface_id}`] : []                                // a later revision updates the block in place
    }
    return []
  })
  expect(live).toEqual(['text:这段解释', 'call:u1', 'ui:loan', 'text:再看这个', 'call:u2', 'ui:page', 'call:u3', 'text:完成'])
  // reloaded: each surface after its response's words, where it first ran, at its latest revision
  const entries = (await json(await c.get(`/api/runs/${run.id}/transcript`))).entries as TranscriptEntry[]
  const reloaded = entries.flatMap((e) => (e.kind === 'agent' ? [`text:${e.text}`] : e.kind === 'activity' ? [`call:${e.toolCallId}`] : e.kind === 'ui' ? [`ui:${e.surface!.surface_id}@${e.surface!.revision}`] : []))
  expect(reloaded).toEqual(['call:u1', 'text:这段解释', 'ui:loan@2', 'text:再看这个', 'call:u2', 'ui:page@1', 'call:u3', 'text:完成'])
  // the UI never comes before the words of the response whose tool showed it, live or reloaded
  for (const order of [live, reloaded]) {
    expect(order.findIndex((x) => x.startsWith('ui:loan'))).toBeGreaterThan(order.indexOf('text:这段解释'))
    expect(order.findIndex((x) => x.startsWith('ui:page'))).toBeGreaterThan(order.indexOf('text:再看这个'))
  }
})

test('review 7: a surface\'s updated_at strictly increases at every write, even within one millisecond or a clock set back', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const { run } = await presentingRun(c, session, {})
  // a stamp from the future (a clock set back since): the next writes still go forward from it
  const future = new Date(Date.now() + 3_600_000).toISOString()
  app.state.conn.run('UPDATE ui_surfaces SET updated_at=? WHERE run_id=? AND surface_id=?', [future, run.id, 'loan'])
  const stamps: string[] = [future]
  for (let i = 0; i < 20; i += 1) {
    const r = (await json(await c.put(`/api/sessions/${session.id}/ui/${run.id}/loan/state`, { revision: 2, state: { amount: i } }))).surface as UiSurfaceRecord
    stamps.push(r.updated_at)
  }
  const prepared = prepareAction(app.state.conn, session.id, run.id, 'loan', { revision: 2, action_id: 'apply', state: { amount: 99 }, request_id: 'req-stamp-001' })
  stamps.push(prepared.surface.updated_at)
  const republished = presentSurface(app.state.conn, { session_id: session.id, run_id: run.id, model: 'scripted:a' }, calc())
  stamps.push((republished as { surface: UiSurfaceRecord }).surface.updated_at)
  stamps.push(repo.getUiSurface(app.state.conn, session.id, run.id, 'loan')!.updated_at)
  for (let i = 1; i < stamps.length - 1; i += 1) expect(stamps[i]! > stamps[i - 1]!, `${stamps[i]} after ${stamps[i - 1]}`).toBe(true)
  expect(stamps.at(-1)).toBe(stamps.at(-2)!)                                                 // the answer says what was stored
  expect(Date.parse(stamps[1]!) - Date.parse(future)).toBe(1)
})

test('review 8: the model is told how an html surface reaches its state, its draft actions and its run tasks — the bridge as it is, no example', () => {
  const d = PROMPT_TEXT['tool.present_ui']
  for (const s of ['window.oasisUI', 'getState()', 'setState(patch)', 'action(id)', 'click handler', 'confirm', 'never sent on its own', 'external files, fonts and libraries do not load', 'External loads and HTTP navigation are blocked', 'does not guarantee zero network connections', 'may wait until the person runs it', 'Stop works while the app remains responsive']) expect(d, s).toContain(s)
  // the action's two modes and the task bridge (contract/src/ui_interaction.ts OasisUiTaskApi), with the contract's numbers
  const n = (x: number) => x.toLocaleString('en-US')
  for (const s of ['mode draft (the default, when mode is absent)', 'mode run', 'return_ui_result', 'run(id, {input, onProgress})', 'stop(taskId)', 'tasks()', 'onTask(listener)', 'never rejects',
    `at most ${n(UI_TASK_LIMITS.inputChars)} characters, nesting ${UI_TASK_LIMITS.inputDepth}`, `at most ${UI_TASK_LIMITS.queuedPerSession} waiting per conversation`]) expect(d, s).toContain(s)
  // what the page's callbacks and promises carry (no tool schema says it): the result, each update by type, a task's view
  for (const s of ['{ok, task_id, status: succeeded, failed, cancelled or refused', 'error: {code, message} or null', '{type, task_id, action_id}',
    'status {status: queued or running}', 'text {delta: the new text, text: the answer so far (its tail)}', 'tool {name, summary}', 'data {data}', 'done {result}',
    '{task_id, action_id, status, input, text, data, error, created_at, finished_at}', 'resolves true when the stop was accepted', 'returns a function that unsubscribes']) expect(d, s).toContain(s)
  const html = PROMPT_TEXT['parameter.present_ui.html']
  for (const s of ['window.oasisUI', 'action(id)', 'run(id, {input, onProgress})', 'stop(taskId)', 'tasks()', 'onTask(listener)', 'click handler']) expect(html, s).toContain(s)
  expect(PROMPT_TEXT['parameter.present_ui.actions']).toContain('mode: draft (the default')
  // capabilities and mechanism only: no example of a page, no snippet to copy
  for (const text of [d, html, PROMPT_TEXT['parameter.present_ui.actions']]) {
    expect(text).not.toContain('Example')
    expect(text).not.toMatch(/<script|<button|onclick/i)
  }
})

test('the present_ui text states what the app gives an html surface and its limits — the contract\'s numbers, no use cases', () => {
  const d = PROMPT_TEXT['tool.present_ui']
  const html = PROMPT_TEXT['parameter.present_ui.html']
  // what the host supplies and keeps in step; what it does not do
  for (const s of ['HTML fragment or a whole document', 'theme colors as CSS variables', 'typography', 'form controls', 'light or dark theme', 'no reset, font files or CSS framework', 'overrides that base', 'colors you hardcode stay as written', 'initial_state and actions are optional', 'kept with the surface']) expect(d, s).toContain(s)
  // the limits, as the contract has them
  const n = (x: number) => x.toLocaleString('en-US')
  expect(d).toContain(`native ${UI_LIMITS.nodes} elements, nesting ${UI_LIMITS.treeDepth}`)
  expect(d).toContain(`html ${n(UI_LIMITS.htmlChars)} characters`)
  expect(d).toContain(`under ${n(UI_LIMITS.specChars)} characters as JSON`)
  expect(html).toContain(`at most ${n(UI_LIMITS.htmlChars)} characters`)
  // the CSS variables it names are the ones the frame really gets (the frontend's allowlist, state/uiTheme.ts)
  const allow = readFileSync(join(import.meta.dir, '../../frontend/src/state/uiTheme.ts'), 'utf8')
  const block = allow.slice(allow.indexOf('export const UI_THEME_TOKENS'), allow.indexOf('} as const', allow.indexOf('export const UI_THEME_TOKENS')))
  const allowed = new Set([...block.matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]))
  expect(allowed.size).toBe(42)
  const named = [...d.matchAll(/(--[a-z0-9-]+[a-z0-9])/g)].map((m) => m[1]!)
  for (const v of ['--surface', '--ink', '--ink-2', '--line', '--field', '--accent', '--accent-tint', '--radius', '--radius-sm', '--font-body', '--font-heading', '--font-mono']) expect(named).toContain(v)
  for (const v of named) expect(allowed.has(v), v).toBe(true)
  for (const c of ['green', 'orange', 'red']) expect(allowed.has(`--${c}-tint`)).toBe(true)
  expect(d).toContain('card, its title and the Run and Stop controls')
  // capabilities and limits only: no suggestion of what a surface is for, and no example
  for (const text of [d, html, PROMPT_TEXT['parameter.present_ui.kind']]) {
    expect(text).not.toMatch(/\b(e\.g\.|for instance|such as|ideal for|useful for|good for|use it (?:for|to)|calculator|dashboard|simulat\w*|game|quiz|budget|planner|comparison)\b/i)
  }
  expect(d).not.toMatch(/Example:/)
})

test('present_ui html_file: the document read from the working folder when called, kept as it was; edited and shown again; refused plainly where it cannot be read', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const returns: Record<string, Rec> = {}
  const take = (key: string) => (m: ModelMessage[]) => { returns[key] = lastToolReturn(m, 'present_ui') as Rec }
  const filed = (extra: Rec = {}): Rec => ({ version: 1, surface_id: 'demo', title: 'Demo', fallback: 'A demo page.', kind: 'html', html_file: 'demo.html', ...extra })
  setModel(app!.state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('write_file', { path: 'demo.html', content: '<p id="v">first</p>' }, 'w1')]),
    () => modelResponse([toolCallPart('present_ui', filed(), 'u1')]),
    (m) => { take('first')(m); return modelResponse([toolCallPart('edit_file', { path: 'demo.html', old_string: 'first', new_string: 'second' }, 'e1')]) },
    () => modelResponse([toolCallPart('present_ui', filed(), 'u2')]),
    (m) => { take('second')(m); return modelResponse([toolCallPart('present_ui', filed({ html: '<p>both</p>' }), 'u3')]) },
    (m) => { take('both')(m); return modelResponse([toolCallPart('present_ui', filed({ surface_id: 'n', kind: 'native', root: 'a', elements: { a: { type: 'text', props: { text: 'x' } } } }), 'u4')]) },
    (m) => { take('native')(m); return modelResponse([toolCallPart('present_ui', filed({ html_file: 'missing.html' }), 'u5')]) },
    (m) => { take('missing')(m); return modelResponse([toolCallPart('present_ui', filed({ html_file: '../../outside.html' }), 'u6')]) },
    (m) => { take('outside')(m); return modelResponse([toolCallPart('present_ui', filed({ html_file: 'secrets/page.html' }), 'u7')]) },
    (m) => { take('protected')(m); return modelResponse([textPart('Shown.')]) },
  ])))
  const run = await app!.state.runs.start(session, 'show the demo page')
  await collectEvents(app!.state, run.id)
  expect(repo.getRun(app!.state.conn, run.id)!.status).toBe('done')
  expect(returns.first).toMatchObject({ status: 'ok', surface_id: 'demo', revision: 1, kind: 'html' })
  expect(returns.second).toMatchObject({ status: 'ok', surface_id: 'demo', revision: 2 })
  // the record holds the document as it was read, not the path: the edit is revision 2, revision 1 had the first
  const record = repo.getUiSurface(app!.state.conn, session.id, run.id, 'demo')!
  expect(record.revision).toBe(2)
  expect(record.spec.html).toBe('<p id="v">second</p>')
  expect('html_file' in record.spec).toBe(false)
  const errorsOf = (key: string) => { expect(returns[key]!.status, key).toBe('invalid'); return (returns[key]!.errors as string[]).join(' ') }
  expect(errorsOf('both')).toContain('not both')
  expect(errorsOf('native')).toContain('for kind html')
  expect(errorsOf('missing')).toContain('missing.html')
  expect(errorsOf('outside')).toContain('outside.html')
  expect(errorsOf('protected')).toContain('secrets/page.html')
  expect(repo.listUiSurfaces(app!.state.conn, session.id, run.id).map((s) => s.surface_id)).toEqual(['demo'])
})

test('present_ui html_file: a file past the document limit is refused by its size before it is read', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const returns: Record<string, Rec> = {}
  setModel(app!.state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('write_file', { path: 'big.html', content: 'x'.repeat(UI_LIMITS.htmlChars * 4 + 1) }, 'w1')]),
    () => modelResponse([toolCallPart('present_ui', { version: 1, surface_id: 'big', title: 'Big', fallback: 'Big.', kind: 'html', html_file: 'big.html' }, 'u1')]),
    (m) => { returns.big = lastToolReturn(m, 'present_ui') as Rec; return modelResponse([textPart('done')]) },
  ])))
  const run = await app!.state.runs.start(session, 'show it')
  await collectEvents(app!.state, run.id)
  expect(returns.big!.status).toBe('invalid')
  expect((returns.big!.errors as string[]).join()).toContain(`at most ${UI_LIMITS.htmlChars} characters`)
})
