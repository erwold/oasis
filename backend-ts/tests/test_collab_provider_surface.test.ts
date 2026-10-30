/** The tool list a provider actually receives (function tools AND the provider's own builtin tools, as the request
 *  body carries them) is part of a conversation: a request of a conversation carries the list every earlier request
 *  of it carried (the prompt cache keys on it), and the network the session's grant withholds is never handed to the
 *  provider's own search. Pinned over the real runner and a mock Anthropic route (zero network: an injected fetch,
 *  the suite's guard kept). The tool snapshot's rows (`schemaRowsFingerprint`) do not see a builtin tool, so these
 *  compare the request bodies' `tools` themselves.
 *
 *  What counts as compliant is left open where the hard rule allows more than one design: a later request may carry
 *  the same list (when that list is still allowed), or not be sent at all (the run ends or is refused, under any
 *  error name), or — between runs only — the run may go to a new conversation whose boundary is recorded
 *  (forked_from_run_id and a fork_reason). What is never compliant: the same conversation's next request quietly
 *  carrying another list, or a request after the network was withdrawn still declaring the provider's search. */

import { afterEach, expect, test } from 'bun:test'
import { GrantsSchema, type Run, type Session } from '@oasis-code/contract'
import { collabOfRuns } from '../src/agent/collab.ts'
import * as crepo from '../src/db/collab_repo.ts'
import * as repo from '../src/db/repo.ts'
import { AnthropicModel } from '../src/llm/providers/anthropic.ts'
import { appState, buggyRepo, closeState, openSession, setModel, waitDone, type AppState } from './harness.ts'
import { Route } from './helpers.ts'
import { anthropicStream } from './providers_fixtures.ts'

let state: AppState | null = null
afterEach(async () => {
  if (state) await closeState(state)
  state = null
})

type Rec = Record<string, unknown>

const READ = () => anthropicStream({ model: 'claude-x', stop: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'calc.py' } }] })
const DONE = () => anthropicStream({ model: 'claude-x', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['ok'] }] })

/** The tools a request body declared, whole (function tools with their schemas, builtin tools with their options). */
const toolsOf = (body: Rec): string => JSON.stringify(body.tools ?? [])
/** A request that hands the provider its own (networked) search. */
const declaresProviderSearch = (body: Rec): boolean => ((body.tools ?? []) as Rec[]).some((t) => typeof t.type === 'string' && t.type.startsWith('web_search'))

function grant(s: AppState, sessionId: string, network: boolean): void {
  repo.setSessionGrants(s.conn, sessionId, { ...GrantsSchema.parse({}), network })
}

/** A route whose `hook` runs right after request `n` (1-based) reached the provider — i.e. while that model call is
 *  in flight, before its response is read. */
function hookedModel(route: Route, hooks: Record<number, () => void>, profile?: AnthropicModel['profile']): AnthropicModel {
  return new AnthropicModel('claude-x', {
    apiKey: 'k', baseUrl: 'http://anthropic.mock', ...(profile ? { profile } : {}),
    fetchImpl: async (input, init) => {
      const res = await route.fetch(input, init)
      hooks[route.requests.length]?.()
      return res
    },
  })
}

async function opened(network: boolean): Promise<{ s: AppState; session: Session }> {
  const s = await appState()
  state = s
  const { session } = await openSession(s, buggyRepo())
  grant(s, session.id, network)
  return { s, session: repo.getSession(s.conn, session.id)! }
}

function convOf(s: AppState, run: Run): string | null {
  return collabOfRuns(s, run.session_id).get(run.id)?.conversation_id ?? null
}

/** The between-runs rule: run2's requests either stay in run1's conversation with run1's exact list, or run2 is in a
 *  new conversation whose boundary names run1 and a reason. */
function expectSameListOrRecordedBoundary(s: AppState, run1: Run, run2: Run, firstList: string, run2Bodies: Rec[]): void {
  const c1 = convOf(s, run1)
  const c2 = convOf(s, run2)
  expect(c1).not.toBeNull()
  if (run2Bodies.length === 0) return                                                   // refused before any request: compliant
  if (c2 === c1) {
    // same conversation: the list the provider sees is the one it saw — no silent swap
    expect(run2Bodies.map(toolsOf)).toEqual(run2Bodies.map(() => firstList))
  } else {
    const conv = crepo.getConversation(s.conn, c2!)!
    expect(conv.forked_from_run_id).toBe(run1.id)
    expect(conv.fork_reason).toBeTruthy()
  }
}

// -- ① within one run ---------------------------------------------------------------------------------------------

test('① the network withdrawn while a model call is in flight: no later request of the run declares the provider search, and none carries another list', async () => {
  const { s, session } = await opened(true)
  const route = new Route([READ(), DONE()])
  setModel(s, 'scripted:a', hookedModel(route, { 1: () => grant(s, session.id, false) }))
  const run = await waitDone(s, (await s.runs.start(session, 'read calc.py')).id)
  expect(run.status).not.toBe('running')                                               // it ended, whatever it is called
  const [first, ...after] = route.requests
  expect(declaresProviderSearch(first!)).toBe(true)                                     // precondition: granted outright at request 1
  // never again a networked builtin once the grant is gone
  expect(after.filter(declaresProviderSearch)).toEqual([])
  // and the conversation's list does not change under the provider: a compliant runner sends no further request
  // (it ends/refuses the run) rather than swap the builtin for the harness's function tool
  expect(after.map(toolsOf)).toEqual(after.map(() => toolsOf(first!)))
})

test('① the network granted while a model call is in flight (an approval that grants it): the run\'s next request keeps the list it had', async () => {
  const { s, session } = await opened(false)
  const route = new Route([READ(), DONE()])
  setModel(s, 'scripted:a', hookedModel(route, { 1: () => grant(s, session.id, true) }))
  const run = await waitDone(s, (await s.runs.start(session, 'read calc.py')).id)
  expect(run.status).not.toBe('running')
  const [first, ...after] = route.requests
  expect(declaresProviderSearch(first!)).toBe(false)                                    // precondition: the harness's tool, which asks
  expect(after.map(toolsOf)).toEqual(after.map(() => toolsOf(first!)))
})

// -- ② the same participant's conversation, continued by its next run ---------------------------------------------

test('② continued after the network was withdrawn: same list in the same conversation is impossible, so a recorded new conversation or a refusal — never a silent swap, never the search again', async () => {
  const { s, session } = await opened(true)
  const route = new Route([DONE()])
  setModel(s, 'scripted:a', hookedModel(route, {}))
  const run1 = await waitDone(s, (await s.runs.start(session, 'hello')).id)
  expect(run1.status).toBe('done')
  const firstList = toolsOf(route.requests[0]!)
  expect(declaresProviderSearch(route.requests[0]!)).toBe(true)
  grant(s, session.id, false)
  const before = route.requests.length
  const run2 = await waitDone(s, (await s.runs.start(repo.getSession(s.conn, session.id)!, 'and again')).id)
  const bodies2 = route.requests.slice(before)
  expect(bodies2.filter(declaresProviderSearch)).toEqual([])
  expectSameListOrRecordedBoundary(s, run1, run2, firstList, bodies2)
})

test("② continued after the model's builtin options changed: the provider's list is not silently filtered in the same conversation", async () => {
  const { s, session } = await opened(true)
  const route = new Route([DONE()])
  setModel(s, 'scripted:a', hookedModel(route, {}))
  const run1 = await waitDone(s, (await s.runs.start(session, 'hello')).id)
  expect(run1.status).toBe('done')
  const firstList = toolsOf(route.requests[0]!)
  expect(declaresProviderSearch(route.requests[0]!)).toBe(true)
  // the same model id now offers no builtin search (a profile/config change, or a route without it)
  setModel(s, 'scripted:a', hookedModel(route, {}, { supports_thinking: true, builtin_tools: [] }))
  const before = route.requests.length
  const run2 = await waitDone(s, (await s.runs.start(repo.getSession(s.conn, session.id)!, 'and again')).id)
  expectSameListOrRecordedBoundary(s, run1, run2, firstList, route.requests.slice(before))
})

// -- ③ a new conversation may choose the new list; the old one is left as it was -----------------------------------

test('③ a fresh conversation takes the list allowed now; the earlier conversation and its history stay as they were', async () => {
  const { s, session } = await opened(true)
  const route = new Route([DONE()])
  setModel(s, 'scripted:a', hookedModel(route, {}))
  const run1 = await waitDone(s, (await s.runs.start(session, 'hello')).id)
  expect(declaresProviderSearch(route.requests[0]!)).toBe(true)
  const c1 = convOf(s, run1)!
  const convBefore = JSON.stringify({ ...crepo.getConversation(s.conn, c1)!, updated_at: null })
  const historyBefore = repo.getRunHistory(s.conn, run1.id)
  grant(s, session.id, false)
  const before = route.requests.length
  const run2 = await waitDone(s, (await s.runs.start(repo.getSession(s.conn, session.id)!, 'new topic', { fresh: true })).id)
  expect(run2.status).toBe('done')
  expect(convOf(s, run2)).not.toBe(c1)
  const bodies = route.requests.slice(before)
  expect(bodies.length).toBeGreaterThan(0)
  expect(bodies.filter(declaresProviderSearch)).toEqual([])
  expect(((bodies[0]!.tools ?? []) as Rec[]).some((t) => t.name === 'web_search' && t.type === undefined)).toBe(true)  // the harness's tool
  expect(JSON.stringify({ ...crepo.getConversation(s.conn, c1)!, updated_at: null })).toBe(convBefore)
  expect(repo.getRunHistory(s.conn, run1.id)).toBe(historyBefore)
})
