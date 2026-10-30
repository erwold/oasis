/** A long session's transcripts: a continued run's inherited count checked with the schema's verdict alone. Every
 *  answer is compared with the earlier count's own (kept here as an oracle); what is counted is calls, never time. */

import { afterEach, expect, spyOn, test } from 'bun:test'
import { ForeignPartSchema, ModelMessageSchema, ModelMessagesSchema, ModelRequestSchema, ModelResponseSchema, ResponsePartSchema } from '@oasis-code/contract'
import { closeDanglingToolCalls } from '../src/agent/runner.ts'
import { inheritedMessageCount, rebuildTranscript } from '../src/agent/transcript.ts'
import type { Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import {
  dumpJson, isModelMessages, loadValue, modelRequest, modelResponse, retryPrompt, textPart, thinkingPart, toolCallPart, toolReturn, userPrompt,
} from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo } from './harness.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

// -- the oracle: the count as it was before (a4dc9ca), verbatim but for its name ---------------------------------

function inheritedBefore(conn: Conn, run: { resumes_run_id: string | null }): number {
  let from: string | null = run.resumes_run_id
  const walked = new Set<string>()
  while (from !== null && !walked.has(from)) {
    walked.add(from)
    const raw = repo.getRunHistory(conn, from)
    if (raw && raw !== '[]') {
      try { return closeDanglingToolCalls(loadValue(JSON.parse(raw))).length } catch { return 0 }
    }
    from = repo.getRun(conn, from)?.resumes_run_id ?? null
  }
  return 0
}

async function project(c: Client) {
  const p = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${p.id}/sessions`, { title: 't' }))
  return { projectId: String(p.id), sessionId: String(s.id), workspaceId: String((s.workspace as Record<string, unknown>).id) }
}

// -- the verdict ---------------------------------------------------------------------------------------------------------

test("the verdict schema is the contract's: a response part's union ends in the catch-all part every member implies", () => {
  // what the equivalence stands on; a contract that changed any of it fails here first
  expect(ModelMessagesSchema.element).toBe(ModelMessageSchema)
  expect(ModelMessageSchema.options).toEqual([ModelRequestSchema, ModelResponseSchema])
  expect(ModelResponseSchema.shape.parts.element).toBe(ResponsePartSchema)
  const members = ResponsePartSchema.options
  expect(members[members.length - 1]).toBe(ForeignPartSchema)
  expect(Object.keys(ForeignPartSchema.shape)).toEqual(['part_kind'])
  expect(ForeignPartSchema.shape.part_kind.def.type).toBe('string')
  for (const member of members) {
    // loose (a part's other keys pass through, as ForeignPartSchema's do) and its part_kind a string
    expect(member.def.catchall?._zod.def.type).toBe('unknown')
    expect(['literal', 'string']).toContain(member.shape.part_kind.def.type)
    if (member.shape.part_kind.def.type === 'literal') for (const v of (member.shape.part_kind.def as { values: unknown[] }).values) expect(typeof v).toBe('string')
  }
})

const VALID = [
  modelRequest([userPrompt('hi', { origin: 'person', app_pieces: [0] }), { part_kind: 'system-prompt', content: 's', dynamic_ref: null }], 'sys'),
  modelRequest([userPrompt(['a', { kind: 'image', asset_id: 'x' }])]),
  modelResponse([textPart('t', { provider_details: { citations: [] } }), thinkingPart('th', { signature: 'sig' }), toolCallPart('read_file', { path: 'a' }, 'c1'),
    toolCallPart('bash', '{"command":"ls"}', 'c2'), { part_kind: 'builtin-tool-call', tool_name: 'web', args: null, tool_call_id: 'b1' },
    { part_kind: 'builtin-tool-return', tool_name: 'web', tool_call_id: 'b1', content: [] }, { part_kind: 'file', note: 'kept as data' }],
  { usage: { input_tokens: 1, details: { cached: 2 } }, finish_reason: 'stop' }),
  modelRequest([toolReturn('read_file', { status: 'ok' }, 'c1', { k: 1 }), retryPrompt([{ loc: 'x' }], 'bash', 'c2')]),
  { ...modelRequest([userPrompt('summary')]), compaction: { covers: 3, tokens_before: null, summary_input_tokens: 5, model: null, at: 't' } },
] as unknown as Record<string, unknown>[]

// values a stored record may hold where another was expected (the JSON a record can read back as)
const ODD: unknown[] = [undefined, null, true, 0, -1, 1.5, 2 ** 53, JSON.parse('1e999'), '', 'x', [], [1], ['s'], [{}], {}, { a: 1 }, { part_kind: 'text' }]

/** Every record one change away from VALID: each key of each message, of each part, of the usage, the compaction
 *  and a list content's pieces replaced by each odd value (or left out), and each whole message or part replaced. */
function* mutants(): Generator<unknown> {
  const clone = () => structuredClone(VALID)
  const set = (obj: Record<string, unknown>, key: string, value: unknown) => { if (value === undefined) delete obj[key]; else obj[key] = value }
  for (const value of ODD) {
    yield value
    yield [value]
  }
  for (const [mi, message] of VALID.entries()) {
    for (const key of [...Object.keys(message), 'unknown_key']) for (const value of ODD) { const r = clone(); set(r[mi]!, key, value); yield r }
    for (const value of ODD) { const r = clone(); (r as unknown[])[mi] = value; yield r }
    const parts = message.parts as Record<string, unknown>[]
    for (const [pi, part] of parts.entries()) {
      for (const key of [...Object.keys(part), 'unknown_key']) {
        for (const value of [...ODD, 'user-prompt', 'system-prompt', 'tool-return', 'retry-prompt', 'text', 'tool-call', 'thinking']) {
          const r = clone(); set((r[mi]!.parts as Record<string, unknown>[])[pi]!, key, value); yield r
        }
      }
      for (const value of ODD) { const r = clone(); (r[mi]!.parts as unknown[])[pi] = value; yield r }
      if (Array.isArray(part.content)) {
        for (const value of ODD) { const r = clone(); ((r[mi]!.parts as Record<string, unknown>[])[pi]!.content as unknown[])[0] = value; yield r }
      }
    }
    for (const nested of ['usage', 'compaction'] as const) {
      const inner = message[nested] as Record<string, unknown> | undefined
      if (!inner) continue
      for (const key of [...Object.keys(inner), 'unknown_key']) for (const value of ODD) { const r = clone(); set(r[mi]![nested] as Record<string, unknown>, key, value); yield r }
    }
    if (message.usage) for (const value of ODD) { const r = clone(); ((r[mi]!.usage as Record<string, unknown>).details as Record<string, unknown>).cached = value; yield r }
  }
}

test("isModelMessages gives loadValue's verdict on every record one change away from a valid one", () => {
  expect(isModelMessages(VALID)).toBe(true)
  expect(() => loadValue(VALID)).not.toThrow()
  let accepted = 0
  let refused = 0
  let total = 0
  for (const value of mutants()) {
    total += 1
    const before = ModelMessagesSchema.safeParse(value).success
    let threw = false
    try { loadValue(value) } catch { threw = true }
    expect(threw).toBe(!before)
    if (isModelMessages(value) !== before) throw new Error(`verdicts differ on ${JSON.stringify(value)?.slice(0, 400)}`)
    if (before) accepted += 1
    else refused += 1
  }
  // the corpus reaches both verdicts in number (a response part's odd member is accepted as a foreign part, a request
  // part's is refused) — deterministic counts of this generator
  expect(total).toBeGreaterThan(1500)
  expect(accepted).toBeGreaterThan(200)
  expect(refused).toBeGreaterThan(500)
})

// -- the inherited count ----------------------------------------------------------------------------------------------

test("a continued run's inherited count is the earlier count on every record its chain can hold, and never parses with the full schema", async () => {
  app = await makeApp()
  const { state } = app
  const conn = state.conn
  const ids = await project(new Client(app))
  const mk = (resumes: string | null, status = 'done') => repo.insertRun(conn, {
    session_id: ids.sessionId, project_id: ids.projectId, workspace_id: ids.workspaceId, model: 'scripted:a', model_config: {}, user_text: 'u', status, budget: {}, resumes_run_id: resumes,
  })
  const setHistory = (id: string, raw: string | null) => conn.run('UPDATE runs SET history_json=? WHERE id=?', [raw, id])

  const answered = dumpJson([modelRequest([userPrompt('a')]), modelResponse([toolCallPart('read_file', {}, 'c1')]), modelRequest([toolReturn('read_file', 'ok', 'c1')]), modelResponse([textPart('done')])])
  const dangling = dumpJson([modelRequest([userPrompt('a')]), modelResponse([toolCallPart('read_file', {}, 'c1'), toolCallPart('bash', {}, 'c2')]), modelRequest([toolReturn('read_file', 'ok', 'c1')])])
  const retried = dumpJson([modelRequest([userPrompt('a')]), modelResponse([toolCallPart('bash', {}, 'c1')]), modelRequest([retryPrompt('bad args', 'bash', 'c1')])])
  // a call left before a compaction is not the working view's: nothing is closed
  const compacted = dumpJson([modelRequest([userPrompt('a')]), modelResponse([toolCallPart('bash', {}, 'c9')]),
    { ...modelRequest([userPrompt('summary')]), compaction: { covers: 2, tokens_before: null, summary_input_tokens: null, model: null, at: 't' } }, modelResponse([textPart('on')])] as never)
  const danglingAfterCompaction = dumpJson([modelRequest([userPrompt('a')]),
    { ...modelRequest([userPrompt('summary')]), compaction: { covers: 1, tokens_before: null, summary_input_tokens: null, model: null, at: 't' } }, modelResponse([toolCallPart('bash', {}, 'c3')])] as never)
  const oddResponsePart = '[{"kind":"request","parts":[{"part_kind":"user-prompt","content":"a"}]},{"kind":"response","parts":[{"part_kind":"text","content":7}]}]'
  const oddRequestPart = '[{"kind":"request","parts":[{"part_kind":"user-prompt","content":7}]}]'

  const grand = mk(null)
  setHistory(grand.id, answered)
  const cases: [string, string | null, number][] = [
    ['answered', answered, 4], ['dangling', dangling, 4], ['retried', retried, 3], ['compacted', compacted, 4], ['dangling after a compaction', danglingAfterCompaction, 4],
    ['an odd response part (a foreign part)', oddResponsePart, 2],
    // refused records count 0 — never walked past
    ['invalid JSON', '[{"kind":', 0], ['not a list', '{"kind":"request"}', 0], ['JSON null', 'null', 0], ['an odd request part', oddRequestPart, 0], ['a list of numbers', '[1]', 0],
    ['whitespace around an empty list (not the empty record)', ' [] ', 0], ['an empty list with a newline', '[]\n', 0],
    // the empty record: the one it continued counts instead
    ['no record', null, 4], ['an empty text', '', 4], ['the empty list', '[]', 4],
  ]
  const parse = spyOn(ModelMessagesSchema, 'parse')
  try {
    for (const [label, raw, expected] of cases) {
      const parent = mk(grand.id)
      setHistory(parent.id, raw)
      const child = mk(parent.id)
      parse.mockClear()
      const before = inheritedBefore(conn, child)
      const beforeParses = parse.mock.calls.length
      parse.mockClear()
      const now = inheritedMessageCount(conn, child)
      expect([label, now]).toEqual([label, before])
      expect([label, now]).toEqual([label, expected])
      // the earlier count parsed a non-empty record with the full schema; this one never does
      expect([label, parse.mock.calls.length]).toEqual([label, 0])
      if (raw !== null && raw !== '' && raw !== '[]' && raw.startsWith('[') && raw.trim() !== '[]' && expected !== 0) expect([label, beforeParses]).toEqual([label, 1])
    }
  } finally { parse.mockRestore() }

  // a missing ancestor, a cycle of empty records, a run that continued none
  const orphan = mk('run_missing')
  expect(inheritedMessageCount(conn, orphan)).toBe(inheritedBefore(conn, orphan))
  expect(inheritedMessageCount(conn, orphan)).toBe(0)
  const a = mk(null)
  const b = mk(a.id)
  conn.run('UPDATE runs SET resumes_run_id=? WHERE id=?', [b.id, a.id])
  expect(inheritedMessageCount(conn, { resumes_run_id: a.id })).toBe(0)
  expect(inheritedMessageCount(conn, { resumes_run_id: a.id })).toBe(inheritedBefore(conn, { resumes_run_id: a.id }))
  expect(inheritedMessageCount(conn, { resumes_run_id: null })).toBe(0)
})

test("the transcript route of a continued run shows its own entries after the inherited ones, as before, active or ended", async () => {
  app = await makeApp()
  const { state } = app
  const conn = state.conn
  const c = new Client(app)
  const ids = await project(c)
  const mk = (resumes: string | null, status: string) => repo.insertRun(conn, {
    session_id: ids.sessionId, project_id: ids.projectId, workspace_id: ids.workspaceId, model: 'scripted:a', model_config: {}, user_text: 'u', status, budget: {}, resumes_run_id: resumes,
  })
  const first = [modelRequest([userPrompt('first')]), modelResponse([toolCallPart('read_file', { path: 'a' }, 'c1')])]
  const parent = mk(null, 'cancelled')
  repo.saveRunProgress(conn, parent.id, dumpJson(first as never), {}, 0)
  // the runner closed the parent's dangling call when it loaded it: one message more, then this run's own
  const inherited = closeDanglingToolCalls(first as never)
  const own = [...inherited, modelRequest([userPrompt('second')]), modelResponse([toolCallPart('bash', { command: 'ls' }, 'c2')])]
  for (const status of ['running', 'error', 'cancelled', 'done']) {
    const child = mk(parent.id, status)
    repo.saveRunProgress(conn, child.id, dumpJson(own as never), {}, 0)
    const body = await json(await c.get(`/api/runs/${child.id}/transcript`))
    const ended = status === 'running' ? null : status
    expect(body).toEqual({ run_id: child.id, status, model: 'scripted:a', entries: rebuildTranscript(dumpJson(own as never), inheritedBefore(conn, child), ended, [], [], []), steers: [] })
    const entries = body.entries as Record<string, unknown>[]
    expect(entries.map((e) => e.kind)).toEqual(['user', 'activity'])
    expect(entries[0]!.text).toBe('second')
    expect(entries[1]!.running).toBe(status === 'running')
  }
  const missing = await c.get('/api/runs/run_nope/transcript')
  expect(missing.status).toBe(404)
})
