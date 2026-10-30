/** Every request a provider receives is a prefix extension of the one before — measured on the bytes the real
 *  mappings put on the wire (the Messages API body, the Responses API body), through the runner, over one
 *  scripted conversation: tool calls, an image the agent read, a second run reloaded from the database, a relay
 *  whose participants keep their own contexts, a further round, a run on another provider continuing the thread
 *  (a new prefix, the record itself unchanged), and a compaction (the summary request extends the prefix; the
 *  request after it begins anew, once). Zero cloud calls: the providers are played by fakes on the loopback. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCompaction } from '../src/agent/history.ts'
import { rebuildTranscript } from '../src/agent/transcript.ts'
import { ModelConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import type { FetchLike } from '../src/llm/http.ts'
import { loadJson } from '../src/llm/messages.ts'
import { AnthropicModel, OpenAIResponsesModel } from '../src/llm/providers.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { appState, buggyRepo, closeState, openSession, setModel, sleep, testConfig, waitDone, type AppState } from './harness.ts'
import { anthropicStream, openaiStream } from './providers_fixtures.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const A = 'scripted:a'
const B = 'scripted:b'
type Body = Record<string, unknown>
type Labelled = { label: string; body: Body }

/** A fake Anthropic route: records every body under the current label, answers the next planned response (a
 *  summary when the compaction prompt is the last text of the last user turn; a final text when the plan is empty). */
function anthropicRoute(seen: Labelled[], label: () => string, plan: () => Record<string, unknown>[][], summary: string) {
  const fetchImpl: FetchLike = async (_input, init) => {
    const body = JSON.parse(init?.body as string) as Body
    seen.push({ label: label(), body })
    const messages = body.messages as { role: string; content: { type: string; text?: string }[] }[]
    const last = messages[messages.length - 1]!
    const lastText = last.role === 'user' ? [...last.content].reverse().find((b) => b.type === 'text')?.text : undefined
    const input = Math.ceil(JSON.stringify(messages).length / 4)
    let blocks: Record<string, unknown>[]
    if (lastText === PROMPT_TEXT['compaction.request']) blocks = [{ type: 'text', pieces: [`<summary>${summary}</summary>`] }]
    else blocks = plan().shift() ?? [{ type: 'text', pieces: ['done: the render is red and add() subtracts.'] }]
    const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
    return new Response(anthropicStream({ model: 'claude-x', blocks, stop, input_tokens: input }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return fetchImpl
}

function openaiRoute(seen: Labelled[], label: () => string, plan: () => Record<string, unknown>[][]) {
  let n = 0
  const fetchImpl: FetchLike = async (_input, init) => {
    const body = JSON.parse(init?.body as string) as Body
    seen.push({ label: label(), body })
    n += 1
    const items = plan().shift() ?? [{ type: 'message', id: `msg_b${n}`, pieces: ['B: fine, ship it.'] }]
    const input = Math.ceil(JSON.stringify(body.input).length / 4)
    return new Response(openaiStream({ model: 'gpt-y', items, input_tokens: input }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return fetchImpl
}

const readCall = (id: string, path: string) => ({ type: 'tool_use', id, name: 'read_file', input: { path } })

/** The value without its cache_control markers (they move with the conversation and are not the prompt). */
function stripCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCache)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (k !== 'cache_control') out[k] = stripCache(v)
    return out
  }
  return value
}

/** `next` carries `prev` as its prefix: the same model, system and tools, every message of `prev` unchanged at
 *  its index (the breakpoints aside), the new ones after. */
function expectAnthropicExtends(prev: Body, next: Body, where: string): void {
  const p = stripCache(prev) as Body
  const n = stripCache(next) as Body
  expect(n.model, where).toEqual(p.model)
  expect(n.system, where).toEqual(p.system)
  expect(n.tools, where).toEqual(p.tools)
  expect(n.max_tokens, where).toEqual(p.max_tokens)
  const pm = p.messages as unknown[]
  const nm = n.messages as unknown[]
  expect(nm.length, where).toBeGreaterThan(pm.length)
  for (let i = 0; i < pm.length; i += 1) expect(nm[i], `${where}: message ${i}`).toEqual(pm[i])
}

function expectOpenAIExtends(prev: Body, next: Body, where: string): void {
  expect(next.model, where).toEqual(prev.model)
  expect(next.instructions, where).toEqual(prev.instructions)
  expect(next.tools, where).toEqual(prev.tools)
  expect(next.prompt_cache_key, where).toEqual(prev.prompt_cache_key)
  const pi = prev.input as unknown[]
  const ni = next.input as unknown[]
  expect(ni.length, where).toBeGreaterThan(pi.length)
  for (let i = 0; i < pi.length; i += 1) expect(ni[i], `${where}: item ${i}`).toEqual(pi[i])
}

function anthropicBreakpoints(body: Body): { top: unknown; system: unknown; inMessages: boolean } {
  const system = body.system as { cache_control?: unknown }[]
  return { top: body.cache_control, system: system[system.length - 1]!.cache_control, inMessages: JSON.stringify(body.messages).includes('cache_control') }
}

async function waitRelay(st: AppState, relayId: string, statuses: string[], timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const relay = repo.getRelay(st.conn, relayId)!
    if (statuses.includes(relay.status)) {
      for (const step of relay.steps) if (step.run_id && st.runs.handles.get(step.run_id) && !st.runs.handles.get(step.run_id)!.done) await waitDone(st, step.run_id)
      return repo.getRelay(st.conn, relayId)!
    }
    if (Date.now() > end) throw new Error(`relay ${relayId} is ${relay.status} (${relay.reason ?? ''}), not ${statuses.join('|')}`)
    await sleep(20)
  }
}

test('every request extends the one before it, across tool calls, an image, a reload, a relay, a round, a provider change and a compaction', async () => {
  const config = testConfig([
    new ModelConfig({ id: A, label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } }),
    new ModelConfig({ id: B, label: 'Scripted B', provider: 'openai', model: 'scripted-b', api_key_env: 'OASIS_TEST_KEY_B', capabilities: { images: true } }),
  ])
  state = await appState({ config })
  const st = state
  const seenA: Labelled[] = []
  const seenB: Labelled[] = []
  let label = ''
  let planA: Record<string, unknown>[][] = []
  let planB: Record<string, unknown>[][] = []
  const SUMMARY = 'The person asked about the render (red, 7×5) and calc.py (add subtracts); the tests were read; A reviewed README; B approved.'
  setModel(st, A, new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://anthropic.mock', fetchImpl: anthropicRoute(seenA, () => label, () => planA, SUMMARY) }))
  setModel(st, B, new OpenAIResponsesModel('gpt-y', { apiKey: 'k', baseUrl: 'http://openai.mock/v1', fetchImpl: openaiRoute(seenB, () => label, () => planB) }))
  const { session, ws } = await openSession(st, buggyRepo())
  const png = readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-7x5.png'))
  writeFileSync(join(ws.path, 'render.png'), png)
  writeFileSync(join(ws.path, 'big.txt'), ('the quick brown fox jumps over the lazy dog '.repeat(3) + '\n').repeat(1400))   // read_file returns 400 lines: about 15k tokens
  const ofA = (l: string) => seenA.filter((s) => s.label === l).map((s) => s.body)
  const ofB = (l: string) => seenB.filter((s) => s.label === l).map((s) => s.body)

  // 1. a run with two tool calls, one returning an image
  label = 'run1'
  planA = [[{ type: 'thinking', thinking: 'look first', signature: 'sig-1' }, { type: 'text', pieces: ['Looking.'] }, readCall('toolu_1', 'render.png')], [readCall('toolu_2', 'calc.py')]]
  const run1 = await waitDone(st, (await st.runs.start(session, 'look at the render and at calc.py')).id)
  expect(run1.status).toBe('done')
  const r1 = ofA('run1')
  expect(r1).toHaveLength(3)
  expectAnthropicExtends(r1[0]!, r1[1]!, 'run1 request 2')
  expectAnthropicExtends(r1[1]!, r1[2]!, 'run1 request 3')
  expect(JSON.stringify(r1[1]!.messages)).toContain(png.toString('base64'))                 // the image's bytes ride with the result
  const breakpoints = anthropicBreakpoints(r1[2]!)
  // a Claude route keeps its cache an hour by default (cache_ttl '1h')
  expect(breakpoints.top).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(breakpoints.system).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(breakpoints.inMessages).toBe(false)

  // 2. a second run continues the first from the database: its first request extends the first run's last
  label = 'run2'
  planA = [[readCall('toolu_3', 'test_calc.py')]]
  const run2 = await waitDone(st, (await st.runs.start(session, 'and the tests?')).id)
  expect(run2.status).toBe('done')
  expect(run2.resumes_run_id).toBe(run1.id)
  const r2 = ofA('run2')
  expect(r2).toHaveLength(2)
  expectAnthropicExtends(r1[2]!, r2[0]!, 'run2 request 1 over run1 request 3')
  expectAnthropicExtends(r2[0]!, r2[1]!, 'run2 request 2')
  expect(JSON.stringify(r2[1]!.messages)).toContain(png.toString('base64'))                 // still the same bytes, from the store
  // the record: the second run's history begins with the first run's, byte for byte
  const h1 = repo.getRunHistory(st.conn, run1.id)!
  const h2 = repo.getRunHistory(st.conn, run2.id)!
  expect(h2.startsWith(h1.slice(0, -1))).toBe(true)
  expect(run2.usage.context_anchor).toMatchObject({ messages: expect.any(Number), input_tokens: expect.any(Number) })

  // 3. a relay: A keeps its own context (an extension of run 2), B starts its own from the same base with A's packet
  label = 'relay1'
  planA = [[readCall('toolu_4', 'README.md')]]
  planB = []
  const plan = st.relays.plan([{ model: A }, { model: B }], 1, [])
  const { relay } = await st.relays.start(session, { text: 'review it', plan, mentions: [], attachments: [], thinking: null, budget: null, client_request_id: null })
  const done1 = await waitRelay(st, relay.id, ['done', 'error'])
  expect(done1.status, JSON.stringify({ relay: done1, runs: repo.listRunsOfRelay(st.conn, relay.id).map((r) => ({ id: r.id, error: r.error })) })).toBe('done')
  const [aTurn1, bTurn1] = done1.steps.map((s) => repo.getRun(st.conn, s.run_id!)!)
  expect(aTurn1!.resumes_run_id).toBe(run2.id)
  expect(bTurn1!.resumes_run_id).toBe(run2.id)                                             // the same base, not A's turn
  // Different participants are distinct recorded conversation boundaries; each freezes its own provider frame.
  const conversationOf = (id: string) => st.conn.get('SELECT conversation_id FROM run_collab WHERE run_id=?', [id])!.conversation_id
  expect(conversationOf(aTurn1!.id)).not.toBe(conversationOf(bTurn1!.id))
  expect(conversationOf(aTurn1!.id)).not.toBe(conversationOf(run2.id))
  const rA1 = ofA('relay1')
  expect(rA1).toHaveLength(2)
  expectAnthropicExtends(r2[1]!, rA1[0]!, "A's turn over run 2")
  expectAnthropicExtends(rA1[0]!, rA1[1]!, "A's turn request 2")
  const rB1 = ofB('relay1')
  expect(rB1).toHaveLength(1)
  const b1 = JSON.stringify(rB1[0]!.input)
  expect(b1).toContain('done: the render is red')                                          // the base, carried across providers
  expect(b1).toContain('App note: Earlier turns came from')
  expect(b1).toContain(`Turn 1 (A, run ${aTurn1!.id}):`)                                    // A's turn as a packet
  expect(b1).toContain('[read_file README.md → ok')
  const outputs = (rB1[0]!.input as { type?: string; output?: unknown }[]).filter((i) => i.type === 'function_call_output')
  expect(outputs.some((o) => JSON.stringify(o.output).includes('README'))).toBe(false)     // never A's raw result
  expect(rB1[0]!.prompt_cache_key).toBe(`oasis:session:${session.id}`)

  // 4. one more round: A's next turn extends A's own last request; B's extends B's
  label = 'relay2'
  planA = []
  planB = []
  await st.relays.continue(relay.id)
  const done2 = await waitRelay(st, relay.id, ['done', 'error'])
  expect(done2.status).toBe('done')
  const [, , aTurn2, bTurn2] = done2.steps.map((s) => repo.getRun(st.conn, s.run_id!)!)
  expect(aTurn2!.resumes_run_id).toBe(aTurn1!.id)
  expect(bTurn2!.resumes_run_id).toBe(bTurn1!.id)
  const rA2 = ofA('relay2')
  expect(rA2).toHaveLength(1)
  expectAnthropicExtends(rA1[1]!, rA2[0]!, "A's second turn over its first")
  expect(JSON.stringify(rA2[0]!.messages)).toContain('B: fine, ship it.')                   // B's turn reached A as a packet
  const rB2 = ofB('relay2')
  expect(rB2).toHaveLength(1)
  expectOpenAIExtends(rB1[0]!, rB2[0]!, "B's second turn over its first")

  // 5. the thread goes on with A over B's context: a new prefix for A (another provider's record), the record unchanged
  label = 'cross'
  planA = []
  const cross = await waitDone(st, (await st.runs.start(session, 'and now?', { model_id: A })).id)
  expect(cross.status).toBe('done')
  expect(cross.resumes_run_id).toBe(bTurn2!.id)
  const hb = repo.getRunHistory(st.conn, bTurn2!.id)!
  const hc = repo.getRunHistory(st.conn, cross.id)!
  expect(hc.startsWith(hb.slice(0, -1))).toBe(true)
  const rc = ofA('cross')
  expect(rc).toHaveLength(1)
  expect(JSON.stringify(rc[0]!.messages)).toContain('B: fine, ship it.')
  expect(JSON.stringify(rc[0]!.messages)).not.toContain('reasoning')

  // 6. a compaction: under a small window the big result makes the next request summarize; the summary request
  //    extends the prefix, the request after it begins anew — once — and the one after that extends it
  const saved = process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
  process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '40000'                                    // threshold 40 000 − 16 000 − 8 000 = 16 000
  let compacted
  try {
    label = 'compact'
    planA = [[readCall('toolu_5', 'big.txt')], [readCall('toolu_6', 'calc.py')]]
    compacted = await waitDone(st, (await st.runs.start(session, 'read big.txt, then calc.py', { model_id: A })).id)
  } finally {
    if (saved === undefined) delete process.env['OASIS_CODE_CONTEXT_WINDOW_TOKENS' as string]
    else process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = saved
  }
  expect(compacted.status).toBe('done')
  const rk = ofA('compact')
  expect(rk).toHaveLength(4)                                                                // the request, the summary, the fresh one (it calls for calc.py), the answer
  expectAnthropicExtends(rc[0]!, rk[0]!, 'the compacting run over the cross run')
  expectAnthropicExtends(rk[0]!, rk[1]!, 'the summary request over the request before it')
  const summaryTail = (rk[1]!.messages as { role: string; content: { type: string; text?: string }[] }[]).at(-1)!
  expect(summaryTail.content.some((b) => b.type === 'tool_result')).toBe(true)
  expect(summaryTail.content.at(-1)!.text).toBe(PROMPT_TEXT['compaction.request'])
  const fresh = rk[2]!.messages as { role: string; content: { type: string; text?: string }[] }[]
  expect(fresh).toHaveLength(1)
  expect(fresh[0]!.content[0]!.text).toStartWith('App note: The conversation so far was summarized')
  expect(fresh[0]!.content[0]!.text).toContain(SUMMARY)
  expect(fresh[0]!.content.at(-1)!.text).toStartWith('Result of tool call toolu_5 (read_file), returned just before the summary:')
  expect(fresh[0]!.content.at(-1)!.text).toContain('the quick brown fox')
  expect(JSON.stringify(rk[2]!.messages)).not.toContain('B: fine, ship it.')               // summarized, not replayed
  expect(rk[2]!.system).toEqual(rk[1]!.system)                                              // the head is untouched by a compaction
  expect(rk[2]!.tools).toEqual(rk[1]!.tools)
  expectAnthropicExtends(rk[2]!, rk[3]!, 'the request after the compaction')
  expect(JSON.stringify((rk[3]!.messages as unknown[]).at(-1))).toContain('def add(')            // the calc read answered after the compaction
  const events = repo.listEvents(st.conn, compacted.id).filter((e) => e.event === 'context_compacted')
  expect(events).toHaveLength(1)
  expect(events[0]!.data.status).toBe('compacted')
  expect(Number(events[0]!.data.estimate_tokens)).toBeGreaterThan(16_000)
  expect(Number(events[0]!.data.after_tokens)).toBeGreaterThan(0)                             // here the pending result IS the context: the summary cannot shrink it
  const record = loadJson(repo.getRunHistory(st.conn, compacted.id)!)
  expect(record.filter(isCompaction)).toHaveLength(1)
  expect(repo.getRunHistory(st.conn, compacted.id)!.startsWith(hc.slice(0, -1))).toBe(true) // the record kept every earlier message
  const transcript = rebuildTranscript(repo.getRunHistory(st.conn, compacted.id)!)
  expect(transcript.filter((e) => e.kind === 'note' && String(e.text).startsWith('App note: The conversation so far was summarized'))).toHaveLength(1)
  expect(compacted.usage.history_compactions).toBe(1)
  // every model request of the run was metered, the summary request among them
  expect(repo.listModelRequests(st.conn, compacted.id).filter((r) => r.status === 'ok')).toHaveLength(4)
}, 60_000)
