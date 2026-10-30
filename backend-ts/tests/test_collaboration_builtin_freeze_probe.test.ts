/** Probe (audit, not a product fix): within one conversation the tool list a provider receives must not change.
 *  The provider's own web search (a builtin, not a function tool) is decided per request by agent.ts builtinTools()
 *  from the route profile, the order's network and the session's live grant; loop.ts then drops the function
 *  `web_search` whenever a builtin stands. These cases check the request bodies actually sent (scripted Anthropic
 *  route, no network): either every request of the conversation carries the same `tools` array, or — when the
 *  builtin can no longer be offered (grant revoked, route without it) — no further request goes out on that
 *  conversation at all (paused / refused / an explicit new conversation), and no request after a revoke carries
 *  the builtin. A red result here is the finding; it is not to be made green by loosening these expects. */

import { afterEach, expect, test } from 'bun:test'
import { GrantsSchema } from '@oasis-code/contract'
import * as crepo from '../src/db/collab_repo.ts'
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
/** A compact view of a request's tool list: name and kind, in order (the diff the report quotes). */
const shape = (body: Rec): string[] => toolsOf(body).map((t) => `${String(t.name)}:${t.type === WEB_SEARCH_TOOL ? 'builtin' : 'function'}`)
function diff(a: Rec, b: Rec): { removed: string[]; added: string[] } {
  const sa = shape(a), sb = shape(b)
  return { removed: sa.filter((x) => !sb.includes(x)), added: sb.filter((x) => !sa.includes(x)) }
}
const conversationOf = (runId: string): string | null =>
  (state!.conn.get('SELECT conversation_id FROM run_collab WHERE run_id = ?', [runId]) as { conversation_id?: string } | undefined)?.conversation_id ?? null

const readCall = anthropicStream({ model: 'claude-x', stop: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } }] })
const words = (t: string): string => anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: [t] }] })

test('probe A — same run: the session network grant is revoked after the first request; the second request must not carry a different tool list (or must not be sent)', async () => {
  state = await appState()
  const route = new Route([readCall, words('done')])
  let revokeAt = null as number | null
  const fetchImpl: typeof route.fetch = async (input, init) => {
    const res = await route.fetch(input, init)
    if (route.requests.length === 1) {
      // the person narrows the grant while the first response is out (what the session's grant API writes)
      repo.setSessionGrants(state!.conn, sessionId, { ...GrantsSchema.parse({}), network: false })
      revokeAt = 1
    }
    return res
  }
  setModel(state, 'scripted:a', new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl }))
  let { session } = await openSession(state, buggyRepo())
  const sessionId = session.id
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: true })
  session = repo.getSession(state.conn, session.id)!
  const run = await waitDone(state, (await state.runs.start(session, 'look at the readme')).id)

  expect(route.requests.length).toBeGreaterThanOrEqual(1)
  const first = route.requests[0]!
  // precondition: the first real frame offered the provider's own search in place of the function tool
  expect(hasBuiltin(first)).toBe(true)
  expect(revokeAt).toBe(1)
  const later = route.requests.slice(1)
  const report = { status: run.status, requests: route.requests.length, first: shape(first), diffs: later.map((b) => diff(first, b)) }
  if (later.length) console.log('[probe A] actual request diff:', JSON.stringify(report))
  // the frozen list: every later request on this conversation carries exactly the first one's tools …
  for (const body of later) expect(toolsOf(body)).toEqual(toolsOf(first))
  // … and none after the revoke lets the provider reach the network on its own
  for (const body of later) expect(hasBuiltin(body)).toBe(false)
  // (together: after a revoke that removes the builtin, the only conforming outcome is no second request)
})

test('probe B — across runs: the same conversation continued on a route whose profile has no builtin search must keep the tool list (or be refused before any request)', async () => {
  state = await appState()
  const route = new Route([words('first answer')])
  setModel(state, 'scripted:a', new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch }))
  let { session } = await openSession(state, buggyRepo())
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: true })
  session = repo.getSession(state.conn, session.id)!
  const run1 = await waitDone(state, (await state.runs.start(session, 'first question')).id)
  expect(run1.status).toBe('done')
  expect(route.requests.length).toBe(1)
  const first = route.requests[0]!
  expect(hasBuiltin(first)).toBe(true)

  // the same model id now resolves to a route without the provider's search (a route / profile change, grants unchanged)
  route.responses = [words('second answer')]
  setModel(state, 'scripted:a', new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: route.fetch, profile: { builtin_tools: [] } }))
  const run2 = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'continue')).id)
  const conv1 = conversationOf(run1.id), conv2 = conversationOf(run2.id)
  const later = route.requests.slice(1)
  const report = { run2: run2.status, same_conversation: conv1 !== null && conv1 === conv2, requests: route.requests.length, first: shape(first), diffs: later.map((b) => diff(first, b)) }
  if (later.length) console.log('[probe B] actual request diff:', JSON.stringify(report))
  // a request run2 sent on the first run's conversation carries the first frame's tools exactly
  expect(conv1).not.toBeNull()
  if (conv2 === conv1) {
    for (const body of later) expect(toolsOf(body)).toEqual(toolsOf(first))
  } else if (conv2 !== null) {
    // the other conforming outcome: an explicit new conversation, recorded as forked from run1 with a reason
    const row = crepo.getConversation(state.conn, conv2)!
    expect({ forked_from_run_id: row.forked_from_run_id, has_reason: row.fork_reason !== null }).toEqual({ forked_from_run_id: run1.id, has_reason: true })
  } else {
    // refused before any request: nothing went out for run2
    expect(later.length).toBe(0)
  }
})
