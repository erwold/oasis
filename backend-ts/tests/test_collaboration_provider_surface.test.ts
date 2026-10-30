/** The conversation's provider frame (agent/provider_surface.ts): the tools as the provider receives them (functions in
 *  order with their schemas, the provider's own search with its settings) and the static instructions, recorded before
 *  the first request and carried by every later one — or the request refused before it is made. Each case reads the
 *  Anthropic request bodies actually sent (scripted route, no network). */

import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { GrantsSchema } from '@oasis-code/contract'
import { INSTRUCTIONS } from '../src/agent/instructions.ts'
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
const systemText = (body: Rec): string => ((body.system as Rec[] | undefined) ?? []).map((b) => String(b.text ?? '')).join('\n')
const words = (t: string): string => anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: [t] }] })
const conversationOf = (runId: string): string =>
  String((state!.conn.get('SELECT conversation_id FROM run_collab WHERE run_id=?', [runId]) as Rec).conversation_id)
const storedSnapshot = (conv: string): Rec => JSON.parse(String((state!.conn.get('SELECT tool_snapshot_json FROM conversations WHERE id=?', [conv]) as Rec).tool_snapshot_json))
const writeSnapshot = (conv: string, snap: Rec): void => { state!.conn.run('UPDATE conversations SET tool_snapshot_json=? WHERE id=?', [JSON.stringify(snap), conv]) }

async function setup(network: boolean, responses: string[]): Promise<{ route: Route; sessionId: string }> {
  state = await appState()
  const route = new Route(responses)
  setModel(state, 'scripted:a', new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch }))
  const { session } = await openSession(state, buggyRepo())
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network })
  return { route, sessionId: session.id }
}
const start = async (sessionId: string, text: string, o: Parameters<AppState['runs']['start']>[2] = {}) =>
  waitDone(state!, (await state!.runs.start(repo.getSession(state!.conn, sessionId)!, text, o)).id)

test('a grant revoked inside a run: exactly one request goes out, and the run fails with the frame refusal as its reason', async () => {
  const readCall = anthropicStream({ model: 'claude-x', stop: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } }] })
  const { route, sessionId } = await setup(true, [readCall, words('done')])
  const fetch = route.fetch
  ;(route as { fetch: typeof fetch }).fetch = async (input, init) => {
    const res = await fetch(input, init)
    if (route.requests.length === 1) repo.setSessionGrants(state!.conn, sessionId, { ...GrantsSchema.parse({}), network: false })
    return res
  }
  setModel(state!, 'scripted:a', new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch }))
  const run = await start(sessionId, 'look at the readme')
  expect(route.requests.length).toBe(1)
  expect(hasBuiltin(route.requests[0]!)).toBe(true)
  expect(run.status).not.toBe('done')
  expect(run.error ?? '').toContain('provider frame refused')
  expect(run.error ?? '').toContain('no longer grants the network')
})

test('a grant widened later adds no provider search to a conversation that began without it', async () => {
  const { route, sessionId } = await setup(false, [words('one')])
  const run1 = await start(sessionId, 'first')
  expect(run1.status).toBe('done')
  expect(hasBuiltin(route.requests[0]!)).toBe(false)
  expect(toolsOf(route.requests[0]!).some((t) => t.name === 'web_search' && t.type === undefined)).toBe(true)
  repo.setSessionGrants(state!.conn, sessionId, { ...GrantsSchema.parse({}), network: true })
  route.responses = [words('two')]
  const run2 = await start(sessionId, 'second')
  expect(run2.status).toBe('done')
  expect(conversationOf(run2.id)).toBe(conversationOf(run1.id))
  expect(route.requests.length).toBe(2)
  expect(toolsOf(route.requests[1]!)).toEqual(toolsOf(route.requests[0]!))
  expect(systemText(route.requests[1]!)).toBe(systemText(route.requests[0]!))
})

test("an order narrowed to no network on its resume is refused before a request; a fresh conversation takes today's legal frame", async () => {
  const { route, sessionId } = await setup(true, [words('one')])
  const wide = parseWorkOrder({ prompt: 'look around', execution: { commands: true, network: true } })
  const run1 = await start(sessionId, 'look around', { work_order: wide })
  expect(run1.status).toBe('done')
  expect(hasBuiltin(route.requests[0]!)).toBe(true)
  const narrow = parseWorkOrder({ prompt: 'go on', execution: { commands: true, network: false } })
  route.responses = [words('two')]
  const run2 = await start(sessionId, 'go on', { work_order: narrow, resumes_run_id: run1.id })
  expect(conversationOf(run2.id)).toBe(conversationOf(run1.id))
  expect(route.requests.length).toBe(1)
  expect(run2.status).not.toBe('done')
  expect(run2.error ?? '').toContain('order does not allow the network')
  // the person's explicit new conversation: the frame it records is the one allowed now (the harness's own search)
  route.responses = [words('three')]
  const run3 = await start(sessionId, 'start over', { work_order: narrow, fresh: true })
  expect(run3.status).toBe('done')
  expect(conversationOf(run3.id)).not.toBe(conversationOf(run1.id))
  expect(route.requests.length).toBe(2)
  expect(hasBuiltin(route.requests[1]!)).toBe(false)
})

test('the frame is read back from the stored JSON (other snapshot keys kept) and replayed whole, old instructions bytes included', async () => {
  const { route, sessionId } = await setup(true, [words('one')])
  const run1 = await start(sessionId, 'first')
  const conv = conversationOf(run1.id)
  const snap = storedSnapshot(conv)
  // the snapshot's own keys are as the runner wrote them; the frame sits beside them
  for (const k of ['surface', 'basis', 'names', 'rows', 'sha256']) expect(snap[k]).toBeDefined()
  const frame = snap.provider_frame as ProviderFrame
  expect(frame.recorded.run_id).toBe(run1.id)
  expect(frame.instructions).toBe(INSTRUCTIONS)
  expect(frame.sha256).toBe(frameFingerprint(frame))
  expect(toolsOf(route.requests[0]!).map((t) => t.name)).toEqual([...frame.function_tools.map((t) => t.name), ...frame.builtin_tools.map((b) => b.kind)])
  expect(systemText(route.requests[0]!)).toContain(INSTRUCTIONS)
  // an earlier build's frame (its instructions and a tool description as that build had them), as the database holds it
  const old: ProviderFrame = { ...frame, instructions: 'INSTRUCTIONS OF AN EARLIER BUILD', function_tools: frame.function_tools.map((t) => (t.name === 'read_file' ? { ...t, description: 'READ_FILE AS AN EARLIER BUILD DESCRIBED IT' } : t)) }
  old.instructions_sha256 = createHash('sha256').update(old.instructions, 'utf8').digest('hex')
  old.sha256 = frameFingerprint(old)
  writeSnapshot(conv, { ...snap, provider_frame: old, added_by_someone_else: { kept: true } })
  route.responses = [words('two')]
  const run2 = await start(sessionId, 'second')
  expect(run2.status).toBe('done')
  const body = route.requests[1]!
  expect(systemText(body)).toContain('INSTRUCTIONS OF AN EARLIER BUILD')
  expect(systemText(body)).not.toContain(INSTRUCTIONS)
  expect(toolsOf(body).find((t) => t.name === 'read_file')!.description).toBe('READ_FILE AS AN EARLIER BUILD DESCRIBED IT')
  expect(hasBuiltin(body)).toBe(true)
  // nothing rewrote the stored frame or the keys beside it
  const after = storedSnapshot(conv)
  expect(after.provider_frame).toEqual(old)
  expect(after.added_by_someone_else).toEqual({ kept: true })
  expect(readProviderFrame(state!.conn, conv)!.sha256).toBe(old.sha256)
})

test('a conversation from before frames: rebuilt only when its record proves it (instructions sha, tool fingerprint), refused otherwise', async () => {
  const { route, sessionId } = await setup(true, [words('one')])
  const run1 = await start(sessionId, 'first')
  const conv = conversationOf(run1.id)
  const { provider_frame: _f, ...legacy } = storedSnapshot(conv)
  // proven: run1's manifest names these instructions, its request's function fingerprint is that of the list minus
  // `web_search` — the provider's search at the baseline's 5
  writeSnapshot(conv, legacy)
  route.responses = [words('two')]
  const run2 = await start(sessionId, 'second')
  expect(run2.status).toBe('done')
  expect(toolsOf(route.requests[1]!)).toEqual(toolsOf(route.requests[0]!))
  expect((readProviderFrame(state!.conn, conv) as ProviderFrame).basis).toBe('legacy-proven')
  // unproven: the record names instructions this build does not have — no request, the reason given
  writeSnapshot(conv, legacy)
  for (const id of [run1.id, run2.id]) {
    const m = repo.getRun(state!.conn, id)!.manifest as Rec
    state!.conn.run('UPDATE runs SET manifest_json=? WHERE id=?', [JSON.stringify({ ...m, instructions_sha256: 'f'.repeat(64) }), id])
  }
  route.responses = [words('three')]
  const run3 = await start(sessionId, 'third')
  expect(route.requests.length).toBe(2)
  expect(run3.status).not.toBe('done')
  expect(run3.error ?? '').toContain('from before provider frames were recorded')
  expect(readProviderFrame(state!.conn, conv)).toBeNull()
})
