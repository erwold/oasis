import { expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { Conn, connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { projectedOwnHistory, projectedCount, writeHistoryProjection, backfillHistoryProjections } from '../src/db/history_projection.ts'
import { rebuildStoredTranscript, rebuildTranscript } from '../src/agent/transcript.ts'
import { closeDanglingToolCalls } from '../src/agent/runner.ts'
import { dumpJson, isModelMessages, modelRequest, modelResponse, textPart, toolCallPart, userPrompt } from '../src/llm/messages.ts'
import { tempDir } from './helpers.ts'

function fixture() {
  const path = join(tempDir('oasis-history-projection-'), 'index.db'), conn = connect(path)
  const p = repo.createProject(conn, 'synthetic', { source_path: null, base_repo_path: '/synthetic', base_branch: null, base_commit: null, import_report: {} })
  const s = repo.createSession(conn, p.id, 'projection', 'scripted:a')
  const insert = (parent: string | null = null) => repo.insertRun(conn, { session_id: s.id, project_id: p.id, workspace_id: null, model: 'scripted:a', model_config: {}, user_text: 'q', status: 'done', budget: {}, resumes_run_id: parent })
  return { conn, path, s, insert }
}
const history = (text: string) => dumpJson([modelRequest([userPrompt(text)]), modelResponse([textPart(`answer ${text}`)])])
/** Independent source oracle: no projected counts/boundaries and no production inheritedMessageCount helper. */
function oracle(conn: Conn, id: string) {
  let parent = repo.getTranscriptRun(conn, id)!.resumes_run_id, count = 0
  const seen = new Set<string>()
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent)
    const raw = repo.getRunHistory(conn, parent)
    if (raw && raw !== '[]') {
      try { const messages = JSON.parse(raw); count = isModelMessages(messages) ? closeDanglingToolCalls(messages).length : 0 } catch { count = 0 }
      break
    }
    parent = repo.getTranscriptRun(conn, parent)?.resumes_run_id ?? null
  }
  return rebuildTranscript(repo.getRunHistory(conn, id), count, 'done')
}
const read = (conn: Conn, id: string) => rebuildStoredTranscript(conn, repo.getTranscriptRun(conn, id)!, 'done')

test('persisted own history is lossless across reopen/read-only; unrelated writes invalidate only in-memory caches', () => {
  const { conn, path, s, insert } = fixture()
  const parent = insert(), child = insert(parent.id)
  repo.saveRunProgress(conn, parent.id, history('parent'), {}, 1)
  const raw = dumpJson([...JSON.parse(history('parent')), ...JSON.parse(history('child'))])
  repo.saveRunProgress(conn, child.id, raw, {}, 1)
  backfillHistoryProjections(conn)
  const expected = oracle(conn, child.id)
  const get = spyOn(repo, 'getRunHistory')
  try {
    expect(read(conn, child.id)).toEqual(expected)
    repo.renameSession(conn, s.id, 'adjacent metadata write')
    expect(read(conn, child.id)).toEqual(expected)
    expect(get.mock.calls).toHaveLength(0)
    conn.run('PRAGMA query_only=ON')
    expect(read(conn, child.id)).toEqual(expected)
  } finally { get.mockRestore(); conn.close() }
  const ro = new Conn(new Database(path, { readonly: true }), path)
  try { expect(read(ro, child.id)).toEqual(expected); expect(ro.get('SELECT total_changes() AS n')!.n).toBe(0) } finally { ro.close() }
})

test('current inherited boundary wins after parent edits, empty-chain fallback, bad JSON, cycles and deletion', () => {
  const { conn, insert } = fixture()
  try {
    const grand = insert(), parent = insert(grand.id), child = insert(parent.id)
    repo.saveRunProgress(conn, grand.id, history('grand'), {}, 1)
    repo.saveRunProgress(conn, parent.id, history('parent'), {}, 1)
    repo.saveRunProgress(conn, child.id, dumpJson([...JSON.parse(history('parent')), ...JSON.parse(history('child'))]), {}, 1)
    backfillHistoryProjections(conn)
    const variants = [history('rewritten same count'), dumpJson([modelResponse([textPart('one')])]), null, '', '[]', ' [ ] ', 'broken', '{}', '[1e999,-0]']
    for (const raw of variants) {
      conn.run('UPDATE runs SET history_json=? WHERE id=?', [raw, parent.id])
      expect(projectedCount(conn, parent.id)).toBeNull()
      expect(read(conn, child.id)).toEqual(oracle(conn, child.id))
      writeHistoryProjection(conn, parent.id)
      expect(read(conn, child.id)).toEqual(oracle(conn, child.id))
    }
    conn.run('UPDATE runs SET history_json=?, resumes_run_id=? WHERE id=?', ['[]', parent.id, grand.id])
    conn.run('UPDATE runs SET history_json=? WHERE id=?', ['[]', parent.id])
    expect(read(conn, child.id)).toEqual(oracle(conn, child.id))
    conn.run('DELETE FROM runs WHERE id=?', [parent.id])
    expect(read(conn, child.id)).toEqual(oracle(conn, child.id))
  } finally { conn.close() }
})

test('dangling calls and compactions use the same continuation length; own offsets preserve absolute maintenance positions', () => {
  const { conn, insert } = fixture()
  try {
    const parent = insert(), child = insert(parent.id)
    const messages = [modelRequest([userPrompt('old')]), modelResponse([toolCallPart('bash', {}, 'unanswered')])]
    const prefix = closeDanglingToolCalls(messages)
    repo.saveRunProgress(conn, parent.id, dumpJson(messages), {}, 1)
    repo.saveRunProgress(conn, child.id, dumpJson([...prefix, ...JSON.parse(history('new'))]), {}, 1)
    backfillHistoryProjections(conn)
    expect(projectedCount(conn, parent.id)?.count).toBe(prefix.length)
    const events: repo.StoredEvent[] = [{ seq: 1, event: 'context_compacting', data: { compaction_id: 'c', covers: prefix.length + 1 } }]
    const actual = rebuildStoredTranscript(conn, child, 'done', [], [], [], events)
    expect(actual).toEqual(rebuildTranscript(repo.getRunHistory(conn, child.id), prefix.length, 'done', [], [], [], events))
    expect(read(conn, child.id)).toEqual(oracle(conn, child.id))
    // Compaction summarizes the unmatched earlier call; it must not add a closing request to the inherited count.
    const compacted = [...messages, { ...modelRequest([userPrompt('summary')]), compaction: { covers: 2, tokens_before: 100, summary_input_tokens: 20, model: 'synthetic', at: 't' } }]
    repo.saveRunProgress(conn, parent.id, dumpJson(compacted), {}, 2)
    writeHistoryProjection(conn, parent.id)
    expect(isModelMessages(compacted)).toBe(true)
    expect(projectedCount(conn, parent.id)?.count).toBe(closeDanglingToolCalls(compacted).length)
    expect(read(conn, child.id)).toEqual(oracle(conn, child.id))
  } finally { conn.close() }
})

test('source and projection rollback together; second connection rewrites never leave stale stored own history', () => {
  const { conn, path, insert } = fixture(), r = insert()
  const other = new Database(path)
  try {
    repo.saveRunProgress(conn, r.id, history('before'), {}, 1); writeHistoryProjection(conn, r.id)
    const expected = oracle(conn, r.id)
    conn.run('UPDATE run_history_projection SET own_json=? WHERE run_id=?', ['broken derived JSON', r.id])
    expect(projectedOwnHistory(conn, r.id, 0)).toBeNull()
    expect(read(conn, r.id)).toEqual(expected)
    writeHistoryProjection(conn, r.id)
    conn.exec('BEGIN')
    repo.finishRun(conn, r.id, 'done', { history_json: history('tentative'), usage: {}, error: null, receipt: {}, saved_seq: 2 })
    expect(projectedOwnHistory(conn, r.id, 0)).not.toBeNull()
    expect(read(conn, r.id)).toEqual(oracle(conn, r.id))
    conn.exec('ROLLBACK')
    expect(read(conn, r.id)).toEqual(expected)
    other.run('UPDATE runs SET history_json=? WHERE id=?', [history('external'), r.id])
    expect(projectedOwnHistory(conn, r.id, 0)).toBeNull()
    for (let i = 0; i < 3; i++) expect(read(conn, r.id)).toEqual(oracle(conn, r.id))
    repo.finishRun(conn, r.id, 'done', { history_json: history('finished'), usage: {}, error: null, receipt: {}, saved_seq: 3 })
    expect(projectedOwnHistory(conn, r.id, 0)).not.toBeNull()
    expect(read(conn, r.id)).toEqual(oracle(conn, r.id))
  } finally { other.close(); conn.close() }
})

test('oversized and non-roundtrippable projections fall back to full content, not truncated or silently reinterpreted', () => {
  const { conn, insert } = fixture(), r = insert()
  try {
    for (const raw of ['[1e999,-0]', history('x'.repeat(4 * 1024 * 1024)), 'broken', 'null']) {
      repo.saveRunProgress(conn, r.id, raw, {}, 1); writeHistoryProjection(conn, r.id)
      if (raw.startsWith('[1e999') || raw.length > 4 * 1024 * 1024) expect(projectedOwnHistory(conn, r.id, 0)).toBeNull()
      expect(read(conn, r.id)).toEqual(oracle(conn, r.id))
    }
  } finally { conn.close() }
})

test('v37 migration keeps sources, backfills, installs invalidation, and reopens idempotently', () => {
  const { conn, path, insert } = fixture(), r = insert()
  repo.saveRunProgress(conn, r.id, history('migration'), {}, 1)
  const raw = repo.getRunHistory(conn, r.id)
  conn.exec('DROP TRIGGER run_history_projection_invalidate; DROP TRIGGER run_history_projection_delete; DROP TABLE run_history_projection; DROP INDEX runs_display; PRAGMA user_version=37')
  conn.close()
  const migrated = connect(path)
  try {
    expect(migrated.get('PRAGMA user_version')!.user_version).toBe(38)
    expect(repo.getRunHistory(migrated, r.id)).toBe(raw)
    expect(projectedOwnHistory(migrated, r.id, 0)).not.toBeNull()
    expect(read(migrated, r.id)).toEqual(oracle(migrated, r.id))
    const fresh = connect(':memory:')
    const triggers = (c: Conn) => c.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'run_history_projection_%' ORDER BY name")
    try {
      expect(triggers(migrated)).toEqual(triggers(fresh))
      expect(migrated.all('PRAGMA foreign_key_list(run_history_projection)')).toEqual(fresh.all('PRAGMA foreign_key_list(run_history_projection)'))
    } finally { fresh.close() }
    migrated.run('UPDATE runs SET history_json=? WHERE id=?', [history('migrated update'), r.id])
    expect(projectedOwnHistory(migrated, r.id, 0)).toBeNull(); writeHistoryProjection(migrated, r.id)
    migrated.run('UPDATE runs SET resumes_run_id=? WHERE id=?', ['missing-parent', r.id])
    expect(projectedOwnHistory(migrated, r.id, 0)).toBeNull(); writeHistoryProjection(migrated, r.id)
    const plan = migrated.all('EXPLAIN QUERY PLAN SELECT id, usage_json, receipt_json, attachments_json FROM runs INDEXED BY runs_display WHERE session_id=?', ['s'])
    expect(plan.some(r => String(r.detail).includes('COVERING INDEX runs_display'))).toBe(true)
  } finally { migrated.close() }
  const reopened = connect(path)
  try {
    expect(projectedOwnHistory(reopened, r.id, 0)).not.toBeNull()
    reopened.run('DELETE FROM runs WHERE id=?', [r.id])
    expect(reopened.get('SELECT run_id FROM run_history_projection WHERE run_id=?', [r.id])).toBeNull()
  } finally { reopened.close() }
})


test('an external commit after source read cannot publish a stale projection under the new source', () => {
  const { conn, path, insert } = fixture(), r = insert(), other = new Database(path)
  repo.saveRunProgress(conn, r.id, history('old'), {}, 1); writeHistoryProjection(conn, r.id)
  const original = conn.get.bind(conn)
  let wrote = false
  const spy = spyOn(conn, 'get').mockImplementation((sql, args) => {
    const row = original(sql, args)
    if (!wrote && sql === 'SELECT history_json, resumes_run_id FROM runs WHERE id=?') {
      other.run('UPDATE runs SET history_json=? WHERE id=?', [history('new external value'), r.id])
      wrote = true
    }
    return row
  })
  try {
    let failed = false
    try { writeHistoryProjection(conn, r.id) } catch { failed = true }
    expect(wrote).toBe(true); expect(failed).toBe(true) // WAL snapshot upgrade must refuse stale publication
    expect(projectedOwnHistory(conn, r.id, 0)).toBeNull()
    expect(read(conn, r.id)).toEqual(oracle(conn, r.id))
  } finally { spy.mockRestore(); other.close(); conn.close() }
})
