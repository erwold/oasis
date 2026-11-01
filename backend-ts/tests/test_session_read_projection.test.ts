/** Synthetic records only. Pin output equivalence and eliminated work, not machine-dependent time. */
import { afterEach, expect, spyOn, test } from 'bun:test'
import type { Run, TranscriptEntry, UiSurfaceRecord } from '@oasis-code/contract'
import { rebuildStoredTranscript, rebuildTranscript, inheritedMessageCount, UNREADABLE_HISTORY } from '../src/agent/transcript.ts'
import { graphOf, loadRows } from '../src/agent/collab.ts'
import { closeDanglingToolCalls, type RunHandle } from '../src/agent/runner.ts'
import * as repo from '../src/db/repo.ts'
import * as crepo from '../src/db/collab_repo.ts'
import { dumpJson, modelRequest, modelResponse, textPart, toolCallPart, toolReturn, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })
async function fixture() {
  app = await makeApp()
  const conn = app.state.conn
  const p = repo.createProject(conn, 'synthetic', { source_path: null, base_repo_path: '/synthetic', base_branch: null, base_commit: null, import_report: {} })
  const session = repo.createSession(conn, p.id, 'projection', 'scripted:a')
  const run = (parent: string | null = null) => repo.insertRun(conn, { session_id: session.id, project_id: p.id, workspace_id: null,
    model: 'scripted:a', model_config: {}, user_text: 'u', status: 'done', budget: {}, resumes_run_id: parent })
  return { conn, session, run, state: app.state, client: new Client(app) }
}

test('a cold chronological chain reads/parses each history once; warm reads none, with every entry unchanged', async () => {
  const { conn, run } = await fixture()
  const records: { run: Run; raw: string; expected: TranscriptEntry[] }[] = []
  let history: ModelMessage[] = []
  for (let i = 0; i < 24; i++) {
    const r = run(records.at(-1)?.run.id ?? null)
    const from = history.length
    history = [...history, modelRequest([userPrompt(`turn ${i}`)]), modelResponse([toolCallPart('read_file', { path: `file${i}` }, `c${i}`)]),
      modelRequest([toolReturn('read_file', { status: 'ok', synthetic: 'projection-fixture', content: 'x'.repeat(12000) }, `c${i}`)]), modelResponse([textPart(`answer ${i}`)])]
    const raw = dumpJson(history)
    repo.saveRunProgress(conn, r.id, raw, {}, i)
    records.push({ run: r, raw, expected: rebuildTranscript(raw, from, 'done') })
  }
  const rawSet = new Set(records.map((r) => r.raw))
  const read = spyOn(repo, 'getRunHistory')
  const parse = spyOn(JSON, 'parse')
  try {
    for (const r of records) expect(rebuildStoredTranscript(conn, r.run, 'done')).toEqual(r.expected)
    expect(read.mock.calls).toHaveLength(records.length)
    expect(parse.mock.calls.filter(([raw]) => rawSet.has(raw))).toHaveLength(records.length)
    read.mockClear(); parse.mockClear()
    // Different request order does not change either a warm result or the amount of work.
    for (const r of [...records].reverse()) expect(rebuildStoredTranscript(conn, r.run, 'done')).toEqual(r.expected)
    expect(read.mock.calls).toHaveLength(0)
    expect(parse.mock.calls.filter(([raw]) => rawSet.has(raw))).toHaveLength(0)
  } finally { read.mockRestore(); parse.mockRestore() }
})

test('dangling inheritance, empty ancestors, corrupt records and absolute compaction boundaries match the raw rebuild', async () => {
  const { conn, run } = await fixture()
  const parent = run()
  const parentMessages = [modelRequest([userPrompt('old')]), modelResponse([toolCallPart('bash', {}, 'dangling')])]
  repo.saveRunProgress(conn, parent.id, dumpJson(parentMessages), {}, 0)
  const empty = run(parent.id)
  const child = run(empty.id)
  const prefix = closeDanglingToolCalls(parentMessages)
  const raw = dumpJson([...prefix, modelRequest([userPrompt('new')]), modelResponse([textPart('answer')])])
  repo.saveRunProgress(conn, child.id, raw, {}, 0)
  const events: repo.StoredEvent[] = [
    { seq: 1, event: 'context_compacting', data: { compaction_id: 'c1', covers: prefix.length + 1 } },
    { seq: 2, event: 'context_compacted', data: { compaction_id: 'c1', covers: prefix.length + 1, status: 'failed' } },
    { seq: 3, event: 'context_compacting', data: { compaction_id: 'c2', covers: prefix.length + 2 } },
  ]
  for (const ended of [null, 'done', 'error', 'cancelled']) {
    const entries = rebuildStoredTranscript(conn, child, ended, [], [], [], events)
    expect(entries).toEqual(rebuildTranscript(raw, prefix.length, ended, [], [], [], events))
    expect(entries.map((e) => e.kind)).toEqual(['user', 'compaction', 'agent', 'compaction'])
  }
  // A parent larger than its child's record falls back to all child messages, exactly as before.
  const short = dumpJson([modelResponse([textPart('short')])])
  repo.saveRunProgress(conn, child.id, short, {}, 0)
  expect(rebuildStoredTranscript(conn, child, 'done')).toEqual(rebuildTranscript(short, prefix.length, 'done'))
  for (const raw of ['broken', 'null', '{}']) {
    repo.saveRunProgress(conn, child.id, raw, {}, 0)
    expect(rebuildStoredTranscript(conn, child, 'done')).toEqual([{ kind: 'note', text: UNREADABLE_HISTORY }])
  }
  // Invalid nonempty parent: stop here, do not walk through to its valid predecessor.
  conn.run('UPDATE runs SET history_json=? WHERE id=?', ['broken', empty.id])
  expect(inheritedMessageCount(conn, child)).toBe(0)
})

test('history changes with unchanged status and even saved_seq invalidate both own and inherited projections', async () => {
  const { conn, run } = await fixture()
  const parent = run(), child = run(parent.id)
  const a = [modelRequest([userPrompt('first')])]
  const b = [...a, modelResponse([textPart('second')])]
  repo.saveRunProgress(conn, parent.id, dumpJson(a), {}, 7)
  repo.saveRunProgress(conn, child.id, dumpJson(b), {}, 7)
  expect(rebuildStoredTranscript(conn, child, 'done').map((e) => e.text)).toEqual(['second'])
  conn.db.run('UPDATE runs SET history_json=? WHERE id=?', [dumpJson(b), parent.id])
  expect(inheritedMessageCount(conn, child)).toBe(2)
  expect(rebuildStoredTranscript(conn, child, 'done')).toEqual([])
  repo.saveRunProgress(conn, child.id, dumpJson([...b, modelRequest([userPrompt('third')])]), {}, 8)
  expect(rebuildStoredTranscript(conn, child, 'done').map((e) => e.text)).toEqual(['third'])
})

test('status and auxiliary records stay fresh on cache hits; caller mutation cannot change the projection', async () => {
  const { conn, session, run, client } = await fixture()
  const r = run()
  const raw = dumpJson([modelRequest([userPrompt('hello')]), modelResponse([toolCallPart('bash', { command: 'echo synthetic' }, 'c1')])])
  repo.saveRunProgress(conn, r.id, raw, {}, 0)
  const active = rebuildStoredTranscript(conn, r)
  expect(active.find((e) => e.kind === 'activity')?.running).toBe(true)
  const ended = rebuildStoredTranscript(conn, r, 'done')
  expect(ended.find((e) => e.kind === 'activity')?.result?.status).toBe('interrupted')
  ended[0]!.text = 'mutated'
  expect(rebuildStoredTranscript(conn, r, 'done')[0]!.text).toBe('hello')
  const surface = { surface_id: 'synthetic', revision: 1 } as UiSurfaceRecord
  expect(rebuildStoredTranscript(conn, r, 'done', [surface]).at(-1)?.surface?.revision).toBe(1)
  expect(rebuildStoredTranscript(conn, r, 'done', [{ ...surface, revision: 2 }]).at(-1)?.surface?.revision).toBe(2)
  // A finished run's form can be answered after the first transcript request.
  const form = repo.insertUiInput(conn, { session_id: session.id, run_id: r.id, tool_call_id: 'input', request: { title: 'Pick' } })
  const route = () => client.get(`/api/runs/${r.id}/transcript`).then((r) => json<{ entries: TranscriptEntry[] }>(r))
  expect((await route()).entries.find((e) => e.kind === 'input')?.input?.status).toBe('pending')
  repo.answerUiInput(conn, form.id, { status: 'submitted', values: { pick: 'yes' } })
  const answered = (await route()).entries.find((e) => e.kind === 'input')?.input
  expect(answered?.status).toBe('submitted'); expect(answered?.values).toEqual({ pick: 'yes' })
})

test('run metadata and fingerprint reuse SQL without caching live handles; writes refresh every projection', async () => {
  const { conn, session, run, state } = await fixture()
  const r = run()
  const all = spyOn(conn, 'all'), get = spyOn(conn, 'get')
  try {
    const metas = crepo.listRunMetas(conn, session.id)
    const first = crepo.collaborationFingerprint(conn, session.id)
    crepo.listRunMetas(conn, session.id); crepo.collaborationFingerprint(conn, session.id)
    expect(all.mock.calls.filter(([sql]) => sql.includes('AS history_empty'))).toHaveLength(1)
    expect(get.mock.calls.filter(([sql]) => /\bgroup_concat\s*\(\s*status\b/i.test(sql)
      && /\bFROM\s+runs\s+(?:INDEXED\s+BY\s+\w+\s+)?WHERE\s+session_id\s*=\s*\?/i.test(sql))).toHaveLength(1)
    metas[0]!.status = 'mutated'
    expect(crepo.listRunMetas(conn, session.id)[0]!.status).toBe('done')
    conn.run("UPDATE runs SET status='error' WHERE id=?", [r.id])
    expect(crepo.listRunMetas(conn, session.id)[0]!.status).toBe('error')
    expect(crepo.collaborationFingerprint(conn, session.id)).not.toBe(first)
    expect(loadRows(state, session.id).live.has(r.id)).toBe(false)
    state.runs.handles.set(r.id, { run_id: r.id, session_id: session.id, done: false } as RunHandle)
    try {
      expect(graphOf(state, session.id).runs.find((run) => run.id === r.id)?.live).toBe(true)
      state.runs.handles.get(r.id)!.done = true
      expect(graphOf(state, session.id).runs.find((run) => run.id === r.id)?.live).toBe(false)
    } finally { state.runs.handles.delete(r.id) }
    conn.run('UPDATE runs SET history_json=? WHERE id=?', ['[]', r.id])
    expect(crepo.listRunMetas(conn, session.id)[0]!.history_empty).toBe(true)
    conn.run('UPDATE runs SET history_json=? WHERE id=?', [dumpJson([modelResponse([textPart('content')])]), r.id])
    expect(crepo.listRunMetas(conn, session.id)[0]!.history_empty).toBe(false)
  } finally { all.mockRestore(); get.mockRestore() }
})
