/** Provider frames for history from before frames (and before v25's collaboration rows), the tools a provider's own
 *  search must still be allowed, and a damaged stored frame. Each history here is made by the runtime itself on a
 *  scripted Anthropic route (no network); "as v24 left it" then removes what a v24 build never wrote — the session's
 *  run_collab / conversations / participants / collab_edges rows — and keeps every runs row (history, manifest) and
 *  every model_requests row as they were. Each case reads the request bodies actually sent. */

import { afterEach, expect, test } from 'bun:test'
import { GrantsSchema } from '@oasis-code/contract'
import { frameFingerprint, readProviderFrame, type ProviderFrame } from '../src/agent/provider_surface.ts'
import { parseWorkOrder } from '../src/agent/work_orders.ts'
import * as repo from '../src/db/repo.ts'
import { AnthropicModel, WEB_SEARCH_TOOL } from '../src/llm/providers/anthropic.ts'
import { appState, buggyRepo, closeState, openSession, setModel, waitDone, type AppState } from './harness.ts'
import { Route } from './helpers.ts'
import { anthropicStream } from './providers_fixtures.ts'

let state: AppState | null = null
afterEach(async () => {
  if (state) await closeState(state)
  state = null
})

type Rec = Record<string, unknown>
const toolsOf = (body: Rec): Rec[] => (body.tools as Rec[] | undefined) ?? []
const hasBuiltin = (body: Rec): boolean => toolsOf(body).some((t) => t.type === WEB_SEARCH_TOOL)
const words = (t: string): string => anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: [t] }] })
const conn = () => state!.conn
const conversationOf = (runId: string): string | null => {
  const row = conn().get('SELECT conversation_id FROM run_collab WHERE run_id=?', [runId])
  return row ? String(row.conversation_id) : null
}

let route: Route
async function setup(network: boolean): Promise<string> {
  state = await appState()
  route = new Route([words('one')])
  useRoute(['web_search'])
  const { session } = await openSession(state, buggyRepo())
  grant(session.id, network)
  return session.id
}
function useRoute(builtin: ('web_search')[]): void {
  setModel(state!, 'scripted:a', new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch, profile: { builtin_tools: builtin } }))
}
const grant = (sid: string, network: boolean) => repo.setSessionGrants(conn(), sid, { ...GrantsSchema.parse({}), network })
const start = async (sid: string, text: string, o: Parameters<AppState['runs']['start']>[2] = {}) =>
  waitDone(state!, (await state!.runs.start(repo.getSession(conn(), sid)!, text, o)).id)

/** The session as a v24 build left it: no row of v25's collaboration tables; runs and model_requests untouched. */
function asV24(sid: string): void {
  const runs = conn().all('SELECT id, history_json, manifest_json FROM runs WHERE session_id=? ORDER BY id', [sid])
  const requests = conn().all('SELECT * FROM model_requests WHERE run_id IN (SELECT id FROM runs WHERE session_id=?) ORDER BY id', [sid])
  conn().transaction(() => {
    conn().run('DELETE FROM run_collab WHERE session_id=?', [sid])
    conn().run('DELETE FROM collab_edges WHERE session_id=?', [sid])
    conn().run('DELETE FROM conversations WHERE session_id=?', [sid])
    conn().run('DELETE FROM participants WHERE session_id=?', [sid])
  })
  expect(conn().all('SELECT id, history_json, manifest_json FROM runs WHERE session_id=? ORDER BY id', [sid])).toEqual(runs)
  expect(conn().all('SELECT * FROM model_requests WHERE run_id IN (SELECT id FROM runs WHERE session_id=?) ORDER BY id', [sid])).toEqual(requests)
}

/** A runs row as v24 wrote one that a restart cut off before its first request (P11 shape): `like`'s row with an
 *  empty history, no request on record. */
function cutOffRun(like: string, id: string, resumes: string): void {
  const cols = conn().all('PRAGMA table_info(runs)').map((r) => String(r.name))
  const over: Rec = { id, resumes_run_id: resumes, history_json: '[]', status: 'error', error: 'the harness stopped before this run began', client_request_id: null, user_text: 'CUT-OFF' }
  const select = cols.map((c) => (c in over ? '?' : `"${c}"`)).join(', ')
  conn().run(`INSERT INTO runs (${cols.map((c) => `"${c}"`).join(', ')}) SELECT ${select} FROM runs WHERE id=?`, [...cols.filter((c) => c in over).map((c) => over[c] as string | null), like])
}

test('v24 history whose last request had the provider search: continued on the same grant it keeps it; a revoked grant or a route without it is refused before a request', async () => {
  const sid = await setup(true)
  const run1 = await start(sid, 'first')
  expect(run1.status).toBe('done')
  expect(hasBuiltin(route.requests[0]!)).toBe(true)
  asV24(sid)
  // the same grant: the record proves the frame (manifest instructions, the request's function-only fingerprint)
  route.responses = [words('two')]
  const run2 = await start(sid, 'second')
  expect(run2.status).toBe('done')
  expect(run2.resumes_run_id).toBe(run1.id)
  expect(toolsOf(route.requests[1]!)).toEqual(toolsOf(route.requests[0]!))
  const frame = readProviderFrame(conn(), conversationOf(run2.id)!)!
  expect({ basis: frame.basis, source: frame.source?.run_id }).toEqual({ basis: 'legacy-proven', source: run1.id })
  // the grant revoked, on history as v24 left it once more: refused, nothing sent
  asV24(sid)
  grant(sid, false)
  route.responses = [words('three')]
  const run3 = await start(sid, 'third', { resumes_run_id: run2.id })
  expect(route.requests.length).toBe(2)
  expect(run3.status).toBe('error')
  expect(run3.error ?? '').toContain('no longer grants the network')
  // the grant back, the route without the provider's search: refused, nothing sent
  asV24(sid)
  grant(sid, true)
  useRoute([])
  const run4 = await start(sid, 'fourth', { resumes_run_id: run2.id })
  expect(route.requests.length).toBe(2)
  expect(run4.status).toBe('error')
  expect(run4.error ?? '').toContain('route no longer offers')
})

test('v24 history sent with the harness\'s own web_search stays function-only after the grant opens (no provider search added)', async () => {
  const sid = await setup(false)
  const run1 = await start(sid, 'first')
  expect(hasBuiltin(route.requests[0]!)).toBe(false)
  asV24(sid)
  grant(sid, true)
  route.responses = [words('two')]
  const run2 = await start(sid, 'second', { resumes_run_id: run1.id })
  expect(run2.status).toBe('done')
  const second = route.requests[1]!
  expect(hasBuiltin(second)).toBe(false)
  expect(toolsOf(second)).toEqual(toolsOf(route.requests[0]!))
  expect(readProviderFrame(conn(), conversationOf(run2.id)!)!.builtin_tools).toEqual([])
})

test('v24 chain through a run cut off before its first request: the frame comes from the run before it; a run with responses but no request record is refused', async () => {
  const sid = await setup(true)
  const run1 = await start(sid, 'first')
  cutOffRun(run1.id, 'run_cutoff0000000001', run1.id)
  asV24(sid)
  grant(sid, true)
  route.responses = [words('two')]
  const run2 = await start(sid, 'second', { resumes_run_id: 'run_cutoff0000000001' })
  expect(run2.status).toBe('done')
  expect(toolsOf(route.requests[1]!)).toEqual(toolsOf(route.requests[0]!))
  expect(readProviderFrame(conn(), conversationOf(run2.id)!)!.source?.run_id).toBe(run1.id)
  // a run whose history holds responses but no request on record: the tools it was sent are unknown — refused
  asV24(sid)
  conn().run('DELETE FROM model_requests WHERE run_id=?', [run2.id])
  const run3 = await start(sid, 'third', { resumes_run_id: run2.id })
  expect(route.requests.length).toBe(2)
  expect(run3.status).toBe('error')
  expect(run3.error ?? '').toContain('no request on record')
})

test("an order that keeps the network but narrows its tools to read_file refuses the provider's search before a request", async () => {
  const sid = await setup(true)
  const wide = parseWorkOrder({ prompt: 'look around', execution: { commands: true, network: true } })
  const run1 = await start(sid, 'look around', { work_order: wide })
  expect(hasBuiltin(route.requests[0]!)).toBe(true)
  const narrow = parseWorkOrder({ prompt: 'go on', tools: ['read_file'], execution: { commands: true, network: true } })
  route.responses = [words('two')]
  const run2 = await start(sid, 'go on', { work_order: narrow, resumes_run_id: run1.id })
  expect(conversationOf(run2.id)).toBe(conversationOf(run1.id))
  expect(route.requests.length).toBe(1)
  expect(run2.status).toBe('error')
  expect(run2.error ?? '').toContain('tools no longer include web_search')
})

test('a stored frame that is damaged is refused, neither used nor rebuilt', async () => {
  const sid = await setup(true)
  const run1 = await start(sid, 'first')
  const conv = conversationOf(run1.id)!
  const snap = JSON.parse(String(conn().get('SELECT tool_snapshot_json FROM conversations WHERE id=?', [conv])!.tool_snapshot_json)) as Rec
  const frame = snap.provider_frame as ProviderFrame
  expect(frame.sha256).toBe(frameFingerprint(frame))
  // one tool taken out without its fingerprint following (a hand edit, a bad write)
  const damaged = { ...frame, function_tools: frame.function_tools.slice(1) }
  conn().run('UPDATE conversations SET tool_snapshot_json=? WHERE id=?', [JSON.stringify({ ...snap, provider_frame: damaged }), conv])
  route.responses = [words('two')]
  const run2 = await start(sid, 'second')
  expect(route.requests.length).toBe(1)
  expect(run2.status).toBe('error')
  expect(run2.error ?? '').toContain('stored provider frame is damaged')
  const after = JSON.parse(String(conn().get('SELECT tool_snapshot_json FROM conversations WHERE id=?', [conv])!.tool_snapshot_json)) as Rec
  expect(after.provider_frame).toEqual(damaged)
})
