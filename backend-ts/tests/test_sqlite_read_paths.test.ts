/** Schema v33's read paths: three indexes and the run / journal rows read without the columns their mappers drop.
 *  Every production reader v33 touches is called in four cells on one synthetic database — v32 schema + v32 SQL (what
 *  a4dc9ca does), v32 schema + v33 SQL, v33 schema + v32 SQL, v33 schema + v33 SQL (the product) — and each cell must
 *  return exactly what the first returns: the mapped values, their nulls and their order, ties on created_at included.
 *  Plans are checked by their structure (which index, whether a sort is left), never by a time. */

import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { SCHEMA_VERSION } from '@oasis-code/contract'
import { connect, type Conn, type Param } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import {
  baselineSql, openWithoutUpgrade, rewindToV32, V32_REMOTE_EXECUTION_WORKSPACES_SQL, V32_REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, V33_INDEXES, withSql,
  type SqlMode,
} from '../scripts/perf_storage/read_paths_baseline.ts'
import { tempDir } from './helpers.ts'

const TIE = '2026-01-01T00:00:00.000Z'
const EARLY = '2025-12-31T00:00:00.000Z'
const HISTORY = JSON.stringify([{ role: 'user', parts: [{ part_kind: 'text', content: 'h'.repeat(256 * 1024) }] }])

const bytes = (fill: number, n = 2048) => new Uint8Array(n).fill(fill)

interface Fixture {
  sid: string; ws1: string; ws2: string
  runs: Record<string, string>
  executions: string[]
  journal: string[]
  unfinishedRun: string; otherUnfinishedRun: string
}

/** A v33 database filled through the production writers, then taken back to v32's indexes and closed. */
function buildV32(path: string): Fixture {
  const conn = connect(path)
  const pid = repo.createProject(conn, 'synthetic', { source_path: null, base_repo_path: '/synthetic/base.git', base_commit: 'c0', base_branch: 'main', import_report: {} }).id
  const sid = repo.createSession(conn, pid, 'synthetic', 'synthetic:model').id
  const ws1 = repo.insertWorkspace(conn, 'ws_synthetic_a', pid, sid, '/synthetic/a', 'b', 'c0').id
  const ws2 = repo.insertWorkspace(conn, 'ws_synthetic_b', pid, sid, '/synthetic/b', 'b', 'c0').id
  const mk = (o: Partial<Parameters<typeof repo.insertRun>[1]> = {}) => repo.insertRun(conn, { session_id: sid, project_id: pid, workspace_id: null, model: 'synthetic:model', model_config: {}, user_text: 'synthetic', status: 'running', budget: {}, ...o }).id
  const finish = (id: string, status: string, history: string | null, error: string | null = null) =>
    repo.finishRun(conn, id, status, { history_json: history, usage: { input_tokens: 1 }, error, receipt: {}, saved_seq: 1 })
  const runs: Record<string, string> = {}
  // finished with its event; a long history
  runs.done_with_event = mk({ workspace_id: ws1, label: 'labelled' })
  finish(runs.done_with_event, 'done', HISTORY)
  repo.insertEvent(conn, runs.done_with_event, 0, 'run_finished', {})
  // ended without run_finished, created in the same instant, written in an order that is not the status order
  runs.done_no_event = mk()
  finish(runs.done_no_event, 'done', null)
  runs.error_no_event = mk({ workspace_id: ws1 })
  repo.insertEvent(conn, runs.error_no_event, 0, 'text_delta', { text: 'x' })
  finish(runs.error_no_event, 'error', HISTORY, 'synthetic error')
  runs.cancelled_no_event = mk()
  finish(runs.cancelled_no_event, 'cancelled', null)
  runs.running = mk({ workspace_id: ws1 })
  repo.saveRunProgress(conn, runs.running, HISTORY, { input_tokens: 2 }, 3)
  runs.relay_child = mk({ parent_run_id: runs.done_with_event, relay_id: 'relay_synthetic', relay_step: 1, client_request_id: 'synthetic-request', work_order: { version: 3 }, attachments: [], spawned_by: 'agent' })
  finish(runs.relay_child, 'done', HISTORY)
  repo.insertEvent(conn, runs.relay_child, 0, 'run_finished', {})
  runs.relay_node = mk({ relay_id: 'relay_synthetic', relay_step: 2, interaction_id: 'ix_synthetic', interaction_node: 'n1' })
  finish(runs.relay_node, 'done', null)
  runs.node = mk({ interaction_id: 'ix_synthetic', interaction_node: 'n2' })
  finish(runs.node, 'done', HISTORY)
  conn.run('UPDATE runs SET created_at=? WHERE id IN (?,?,?,?,?,?)', [TIE, runs.done_no_event, runs.error_no_event, runs.cancelled_no_event, runs.relay_child, runs.relay_node, runs.node])
  conn.run('UPDATE runs SET created_at=? WHERE id=?', [EARLY, runs.node])

  // executions: three of ws1 in one instant, one of ws1 earlier but written last, two of ws2 tied, one without a
  // workspace; every one but the last has a remote job, the jobs written in the reverse order of the executions
  const x = (workspace: string | null, run: string | null, tool: string | null) =>
    repo.insertExecution(conn, { run_id: run, workspace_id: workspace, tool_call_id: tool, kind: 'command', command: 'true', cwd: '/synthetic', isolation: {}, network: false }).id
  const executions = [x(ws1, runs.done_with_event, 'tc_1'), x(ws1, null, null), x(ws1, runs.running, 'tc_2'), x(ws2, null, null), x(ws2, runs.node, 'tc_3'), x(null, runs.done_no_event, null), x(ws1, null, 'tc_4'), x(ws1, null, null)]
  repo.finishExecution(conn, executions[0]!, { status: 'exited', exit_code: 0, timed_out: false, cancelled: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 3, stderr_bytes: 0, duration_ms: 1 })
  repo.finishExecution(conn, executions[4]!, { status: 'exited', exit_code: 1, timed_out: true, cancelled: false, truncated: true, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 0, stderr_bytes: 5, duration_ms: 2 })
  conn.run('UPDATE executions SET created_at=? WHERE id IN (?,?,?,?,?)', [TIE, executions[0]!, executions[1]!, executions[2]!, executions[3]!, executions[4]!])
  conn.run('UPDATE executions SET created_at=? WHERE id=?', [EARLY, executions[6]!])
  conn.run("INSERT INTO ssh_targets (id, label, destination, created_at) VALUES ('tgt_synthetic', 'synthetic', 'synthetic-host', ?)", [TIE])
  for (const [k, xid] of [...executions.slice(0, 7)].reverse().entries()) {
    conn.run("INSERT INTO remote_jobs (execution_id, target_id, root_id, generation, operation_id) VALUES (?, 'tgt_synthetic', 'root_synthetic', 'g1', ?)", [xid, `op_${k}`])
  }

  // journal of ws1: applied (an edit, a creation, a removal), one left prepared, one unsettled, one abandoned, an undo
  // of the first (no run), and one entry of another run; all but the removal in one instant
  const prep = (run: string | null, before: Uint8Array | null, undoes?: string[]) =>
    repo.prepareJournalEntry(conn, { workspace_id: ws1, session_id: run ? sid : null, run_id: run, tool_call_id: run ? 'tc_j' : null, path: 'f.txt', action: 'edited', before, before_sha: before ? 'sha_before' : null, intended_sha: 'sha_intended', undoes }).id
  const r = runs.done_with_event
  const edit = prep(r, bytes(1)); repo.applyJournalEntry(conn, edit, bytes(2), 'sha_after')
  const create = prep(r, null); repo.applyJournalEntry(conn, create, bytes(3), 'sha_created')
  const remove = prep(r, bytes(4)); repo.applyJournalEntry(conn, remove, null, null)
  const prepared = prep(r, bytes(5))
  const unsettled = prep(r, bytes(6)); repo.settleJournalEntry(conn, unsettled, 'unsettled')
  const abandoned = prep(r, bytes(7)); repo.settleJournalEntry(conn, abandoned, 'abandoned')
  const undo = prep(null, bytes(2), [edit]); repo.applyJournalEntry(conn, undo, bytes(1), 'sha_before')
  const other = prep(runs.node, bytes(8)); repo.applyJournalEntry(conn, other, bytes(9), 'sha_other')
  const journal = [edit, create, remove, prepared, unsettled, abandoned, undo, other]
  conn.run(`UPDATE file_journal SET created_at=? WHERE id<>?`, [TIE, remove])
  conn.run('UPDATE file_journal SET created_at=? WHERE id=?', [EARLY, remove])

  rewindToV32(conn)
  conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
  conn.close()
  return { sid, ws1, ws2, runs, executions, journal, unfinishedRun: runs.done_no_event, otherUnfinishedRun: runs.cancelled_no_event }
}

/** Every reader v33 touches, as the product calls it; each returns what its caller receives. */
function readers(f: Fixture): Record<string, (c: Conn) => unknown> {
  const out: Record<string, (c: Conn) => unknown> = {
    listRuns: (c) => repo.listRuns(c, f.sid),
    listThreadRuns: (c) => repo.listThreadRuns(c, f.sid),
    latestRunOfSession: (c) => repo.latestRunOfSession(c, f.sid),
    latestRunOfSession_sourceContinuations: (c) => repo.latestRunOfSession(c, f.sid, { sourceContinuations: true }),
    listRunsWithStatus: (c) => repo.listRunsWithStatus(c, ['queued', 'running', 'waiting', 'done']),
    listRunsOfRelay: (c) => repo.listRunsOfRelay(c, 'relay_synthetic'),
    listRunsOfInteraction: (c) => repo.listRunsOfInteraction(c, 'ix_synthetic'),
    runForClientRequest: (c) => repo.runForClientRequest(c, f.sid, 'synthetic-request'),
    runForClientRequest_absent: (c) => repo.runForClientRequest(c, f.sid, 'no-such-request'),
    runsWithoutFinishEvent: (c) => repo.runsWithoutFinishEvent(c),
    listExecutions_ws1: (c) => repo.listExecutions(c, { workspace_id: f.ws1 }),
    listExecutions_ws2: (c) => repo.listExecutions(c, { workspace_id: f.ws2 }),
    listExecutions_null_workspace: (c) => repo.listExecutions(c, { workspace_id: null }),
    listExecutions_run: (c) => repo.listExecutions(c, { run_id: f.runs.done_with_event }),
    listJournal_run: (c) => repo.listJournal(c, { run_id: f.runs.done_with_event }),
    listJournal_other_run: (c) => repo.listJournal(c, { run_id: f.runs.node }),
    listJournal_workspace: (c) => repo.listJournal(c, { workspace_id: f.ws1 }),
    listPreparedJournal_all: (c) => repo.listPreparedJournal(c),
    listPreparedJournal_run: (c) => repo.listPreparedJournal(c, f.runs.done_with_event),
    listUnsettledJournal: (c) => repo.listUnsettledJournal(c, f.runs.done_with_event),
    listJournalUndos: (c) => repo.listJournalUndos(c, f.ws1, EARLY),
  }
  for (const [name, id] of Object.entries(f.runs)) {
    out[`getRun_${name}`] = (c) => repo.getRun(c, id)
    out[`getRunHistory_${name}`] = (c) => repo.getRunHistory(c, id)
  }
  f.executions.forEach((id, i) => { out[`getExecution_${i}`] = (c) => repo.getExecution(c, id) })
  f.journal.forEach((id, i) => {
    out[`getJournalEntry_${i}`] = (c) => repo.getJournalEntry(c, id)
    out[`journalBytes_before_${i}`] = (c) => repo.journalBytes(c, id, 'before')
    out[`journalBytes_after_${i}`] = (c) => repo.journalBytes(c, id, 'after')
  })
  return out
}

/** The two remote reads, as src/main.ts and runningInWorkspace use them. v32's SQL stated no order; its plan scanned
 *  executions in rowid order, and v33's SQL states that order (the order recovery takes locks in). */
function remoteReaders(f: Fixture): Record<string, (c: Conn) => string[]> {
  return {
    remote_workspaces_of_a_start: (c) => [...new Set(c.all(repo.REMOTE_EXECUTION_WORKSPACES_SQL).map((r) => String(r.workspace_id)))],
    remote_executions_of_ws1: (c) => c.all(repo.REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, [f.ws1]).map((r) => String(r.execution_id)),
    remote_executions_of_ws2: (c) => c.all(repo.REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, [f.ws2]).map((r) => String(r.execution_id)),
    remote_executions_of_no_workspace: (c) => c.all(repo.REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, [null]).map((r) => String(r.execution_id)),
  }
}

function record(conn: Conn, fn: () => unknown): { sql: string; params: Param[] }[] {
  const seen: { sql: string; params: Param[] }[] = []
  const all = conn.all.bind(conn), get = conn.get.bind(conn)
  conn.all = (sql, params = []) => { seen.push({ sql, params }); return all(sql, params) }
  conn.get = (sql, params = []) => { seen.push({ sql, params }); return get(sql, params) }
  try { fn() } finally { delete (conn as Partial<Conn>).all; delete (conn as Partial<Conn>).get }
  return seen
}

const plan = (conn: Conn, sql: string, params: Param[] = []): string[] =>
  conn.all(`EXPLAIN QUERY PLAN ${sql}`, params).map((r) => String(r.detail))

function open(): { f: Fixture; v32: Conn; v33: Conn; v32Path: string; v33Path: string; dir: string } {
  const dir = tempDir()
  const v32Path = join(dir, 'v32', 'index.db')
  const f = buildV32(v32Path)
  const v33Path = join(dir, 'index.db')
  copyFileSync(v32Path, v33Path)
  return { f, v32: openWithoutUpgrade(v32Path), v33: connect(v33Path), v32Path, v33Path, dir }
}

test('a v32 database upgrades to v33 once, after the copy before an upgrade, with every row kept and the indexes a fresh one has', () => {
  const { v32, v33, v33Path, dir } = open()
  const fresh = connect(join(dir, 'fresh', 'index.db'))
  try {
    expect(SCHEMA_VERSION).toBe(38)
    expect(v32.get('PRAGMA user_version')!.user_version).toBe(32)
    expect(v33.get('PRAGMA user_version')!.user_version).toBe(38)
    for (const table of ['runs', 'run_events', 'executions', 'remote_jobs', 'file_journal', 'sessions', 'workspaces']) {
      expect(v33.get(`SELECT count(*) AS n FROM ${table}`)!.n, table).toBe(v32.get(`SELECT count(*) AS n FROM ${table}`)!.n)
    }
    const indexSql = (c: Conn) => Object.fromEntries(V33_INDEXES.map((name) => [name, String(c.get("SELECT sql FROM sqlite_master WHERE type='index' AND name=?", [name])?.sql ?? '').replace(/\s+/g, ' ')]))
    expect(indexSql(v33)).toEqual(indexSql(fresh))
    expect(indexSql(v33).file_journal_by_run).toBe('CREATE INDEX file_journal_by_run ON file_journal(run_id, created_at)')
    expect(indexSql(v33).run_events_finished_by_run).toContain("WHERE event = 'run_finished'")
    // the copy is the database as v32 left it
    const backup = `${v33Path}.v32.bak`
    expect(existsSync(backup)).toBe(true)
    const copy = new Database(backup, { readonly: true })
    try {
      expect((copy.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(32)
      expect(copy.query("SELECT name FROM sqlite_master WHERE name IN ('run_events_finished_by_run', 'executions_by_workspace')").all()).toEqual([])
      expect(String((copy.query("SELECT sql FROM sqlite_master WHERE name='file_journal_by_run'").get() as { sql: string }).sql)).toBe('CREATE INDEX file_journal_by_run ON file_journal(run_id)')
      expect((copy.query('SELECT count(*) AS n FROM file_journal').get() as { n: number }).n).toBe(Number(v32.get('SELECT count(*) AS n FROM file_journal')!.n))
    } finally { copy.close() }
    // opened again: nothing to do, the copy left as it was
    const before = statSync(backup).mtimeMs
    v33.close()
    const again = connect(v33Path)
    expect(again.get('PRAGMA user_version')!.user_version).toBe(38)
    expect(readdirSync(dir).filter((n) => n.includes('.bak'))).toEqual(['index.db.v32.bak'])
    expect(statSync(backup).mtimeMs).toBe(before)
    again.close()
  } finally { v32.close(); fresh.close() }
})

test('every reader returns in each of the four cells exactly what v32 returns: values, nulls, order and ties', () => {
  const { f, v32, v33 } = open()
  try {
    const cells: [string, Conn, SqlMode][] = [['v32 schema, v33 SQL', v32, 'v33'], ['v33 schema, v32 SQL', v33, 'v32'], ['v33 schema, v33 SQL', v33, 'v33']]
    for (const [name, read] of Object.entries(readers(f))) {
      const baseline = withSql(v32, 'v32', () => read(v32))
      for (const [cell, conn, mode] of cells) expect(withSql(conn, mode, () => read(conn)), `${name}: ${cell}`).toStrictEqual(baseline)
    }
    // the fixture holds what the comparison is about: ties, nulls and the complete history
    const unfinished = repo.runsWithoutFinishEvent(v33)
    expect(unfinished.map((r) => r.id).sort()).toEqual([f.runs.done_no_event, f.runs.error_no_event, f.runs.cancelled_no_event, f.runs.relay_node, f.runs.node].sort())
    expect(new Set(unfinished.filter((r) => r.created_at === TIE).map((r) => r.status))).toEqual(new Set(['done', 'error', 'cancelled']))
    expect(repo.getRunHistory(v33, f.runs.done_with_event)).toBe(HISTORY)
    expect(repo.getRunHistory(v33, f.runs.running)).toBe(HISTORY)
    expect(repo.getRunHistory(v33, f.runs.done_no_event)).toBeNull()
    expect('history_json' in (repo.getRun(v33, f.runs.done_with_event) as object)).toBe(false)
    const ws1 = repo.listExecutions(v33, { workspace_id: f.ws1 }).map((x) => x.id)
    expect(ws1).toEqual(v33.all('SELECT id FROM executions WHERE workspace_id=? ORDER BY created_at, rowid', [f.ws1]).map((r) => String(r.id)))
    expect(ws1[0]).toBe(f.executions[6])                                        // written last, earliest in time
    expect(repo.listJournal(v33, { run_id: f.runs.done_with_event }).map((e) => e.id)).toEqual([f.journal[2], f.journal[0], f.journal[1]])
    expect(repo.listPreparedJournal(v33, f.runs.done_with_event).map((e) => e.id)).toEqual([f.journal[3]])
    expect(repo.listUnsettledJournal(v33, f.runs.done_with_event).map((e) => e.id)).toEqual([f.journal[4]])
    expect(repo.listJournalUndos(v33, f.ws1, EARLY).map((e) => e.id)).toEqual([f.journal[6]])
    expect(repo.getJournalEntry(v33, f.journal[0]!)!.undone_by).toBe(f.journal[6]!)
    expect(repo.getJournalEntry(v33, f.journal[1]!)!.before_exists).toBe(false)
    expect(repo.journalBytes(v33, f.journal[1]!, 'before')).toBeNull()
    expect(repo.journalBytes(v33, f.journal[2]!, 'after')).toBeNull()
    expect(Buffer.from(repo.journalBytes(v33, f.journal[0]!, 'after')!).equals(Buffer.from(bytes(2)))).toBe(true)
    // the remote reads: in all four cells, in v32's order — a workspace named by several commands once, by its first
    // command; the command without a workspace as String(null), as src/main.ts reads it; no command matched by a null
    // (v33's index under v32's unordered SQL — not a state the product is ever in — returns the same rows in another
    // order on this fixture: why v33's SQL states the order; only the rows are compared for that cell)
    for (const [name, read] of Object.entries(remoteReaders(f))) {
      const baseline = withSql(v32, 'v32', () => read(v32))
      for (const [cell, conn, mode] of cells) {
        const got = withSql(conn, mode, () => read(conn))
        if (cell === 'v33 schema, v32 SQL') expect([...got].sort(), `${name}: ${cell}`).toEqual([...baseline].sort())
        else expect(got, `${name}: ${cell}`).toStrictEqual(baseline)
      }
    }
    const byRowid = (ws: string) => v33.all('SELECT r.execution_id FROM remote_jobs r JOIN executions e ON e.id=r.execution_id WHERE e.workspace_id=? ORDER BY e.rowid', [ws]).map((r) => String(r.execution_id))
    expect(remoteReaders(f).remote_executions_of_ws1!(v33)).toEqual(byRowid(f.ws1))
    expect(remoteReaders(f).remote_workspaces_of_a_start!(v33)).toEqual([f.ws1, f.ws2, 'null'])   // first commands: x0 (ws1), x3 (ws2), x5 (none)
    expect([...remoteReaders(f).remote_workspaces_of_a_start!(v33)].sort()).toEqual([f.ws1, f.ws2, 'null'].sort())
    expect([...remoteReaders(f).remote_executions_of_ws1!(v33)].sort()).toEqual([f.executions[0]!, f.executions[1]!, f.executions[2]!, f.executions[6]!].sort())
    expect(remoteReaders(f).remote_executions_of_no_workspace!(v33)).toEqual([])
  } finally { v32.close(); v33.close() }
})

test('the run readers and the journal readers that pick entries read neither history_json nor a blob, and say every other column', () => {
  const { f, v33, v32 } = open()
  try {
    const runColumns = v33.all('PRAGMA table_info(runs)').map((r) => String(r.name)).filter((n) => n !== 'history_json')
    expect(repo.RUN_COLUMNS.split(', ').sort()).toEqual(runColumns.sort())
    expect(repo.RUN_COLUMNS_R).toBe(repo.RUN_COLUMNS.split(', ').map((c) => `r.${c}`).join(', '))
    const journalColumns = v33.all('PRAGMA table_info(file_journal)').map((r) => String(r.name)).filter((n) => n !== 'before_blob' && n !== 'after_blob')
    expect(repo.JOURNAL_COLUMNS.split(', ').sort()).toEqual(journalColumns.sort())
    // listJournal and listJournalUndos keep v32's whole-row statements (a narrower list measured no faster for them)
    const wholeRows = new Set(['listJournal_run', 'listJournal_other_run', 'listJournal_workspace', 'listJournalUndos'])
    for (const [name, read] of Object.entries(readers(f))) {
      if (name.startsWith('getRunHistory_') || name.startsWith('journalBytes_')) continue
      for (const { sql } of record(v33, () => read(v33))) {
        if (wholeRows.has(name)) {
          expect(sql.startsWith('SELECT * FROM file_journal '), name).toBe(true)
          expect(baselineSql(sql), name).toBe(sql)
        } else expect(sql, name).not.toMatch(/history_json|before_blob|after_blob|SELECT \*|r\.\*/)
      }
    }
    // the statements v32 ran, as a4dc9ca has them, come back from the v33 ones
    const v32Statements = new Set<string>()
    for (const read of Object.values(readers(f))) for (const { sql } of record(v32, () => withSql(v32, 'v32', () => read(v32)))) v32Statements.add(sql)
    for (const sql of [
      'SELECT * FROM runs WHERE id=?',
      'SELECT * FROM runs WHERE session_id=? ORDER BY created_at',
      'SELECT * FROM runs WHERE session_id=? AND client_request_id=?',
      'SELECT * FROM runs WHERE relay_id=? ORDER BY created_at, rowid',
      'SELECT * FROM runs WHERE interaction_id=? ORDER BY created_at, rowid',
      "SELECT r.* FROM runs r WHERE r.status IN ('done','error','cancelled') AND NOT EXISTS (SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.event='run_finished') ORDER BY r.created_at",
      'SELECT * FROM file_journal WHERE id=?',
      "SELECT * FROM file_journal WHERE run_id=? AND state='applied' ORDER BY created_at, rowid",
      "SELECT * FROM file_journal WHERE workspace_id=? AND state='applied' ORDER BY created_at, rowid",
      "SELECT * FROM file_journal WHERE state='prepared' AND run_id=? ORDER BY created_at, rowid",
      "SELECT * FROM file_journal WHERE state='prepared' ORDER BY created_at, rowid",
      "SELECT * FROM file_journal WHERE state='unsettled' AND run_id=? ORDER BY created_at, rowid",
      "SELECT * FROM file_journal WHERE workspace_id=? AND run_id IS NULL AND state='applied' AND created_at>=? ORDER BY created_at, rowid",
    ]) expect(v32Statements.has(sql), sql).toBe(true)
    for (const read of Object.values(remoteReaders(f))) for (const { sql } of record(v32, () => withSql(v32, 'v32', () => read(v32)))) v32Statements.add(sql)
    expect(v32Statements.has(V32_REMOTE_EXECUTION_WORKSPACES_SQL) && v32Statements.has(V32_REMOTE_EXECUTIONS_OF_WORKSPACE_SQL)).toBe(true)
  } finally { v32.close(); v33.close() }
})

test('the plans: each new index is taken where it is meant to be, and a projection never changes a plan', () => {
  const { f, v32, v33 } = open()
  try {
    // the narrower column lists leave every plan as it was, on either schema
    for (const read of Object.values(readers(f))) {
      for (const { sql, params } of record(v33, () => read(v33))) {
        expect(plan(v33, sql, params), sql).toEqual(plan(v33, baselineSql(sql), params))
        expect(plan(v32, sql, params), sql).toEqual(plan(v32, baselineSql(sql), params))
      }
    }
    const only = (conn: Conn, fn: () => unknown) => { const s = record(conn, fn); expect(s.length).toBe(1); return plan(conn, s[0]!.sql, s[0]!.params) }
    const unfinished = only(v33, () => repo.runsWithoutFinishEvent(v33))
    expect(unfinished.some((l) => l.includes('run_events_finished_by_run'))).toBe(true)
    // the outer loop over runs is the one v32 had (and so the order of runs that tie on created_at)
    const outer = (lines: string[]) => lines.filter((l) => !/^(SEARCH|SCAN) e\b/.test(l))
    expect(outer(unfinished)).toEqual(outer(only(v32, () => withSql(v32, 'v32', () => repo.runsWithoutFinishEvent(v32)))))
    const byWorkspace = only(v33, () => repo.listExecutions(v33, { workspace_id: f.ws1 }))
    expect(byWorkspace.some((l) => l.includes('executions_by_workspace'))).toBe(true)
    expect(byWorkspace.some((l) => l.includes('TEMP B-TREE'))).toBe(false)
    expect(only(v32, () => repo.listExecutions(v32, { workspace_id: f.ws1 })).some((l) => l.includes('TEMP B-TREE'))).toBe(true)
    for (const read of [(c: Conn) => repo.listJournal(c, { run_id: f.runs.done_with_event }), (c: Conn) => repo.listPreparedJournal(c, f.runs.done_with_event), (c: Conn) => repo.listUnsettledJournal(c, f.runs.done_with_event)]) {
      const lines = only(v33, () => read(v33))
      expect(lines.some((l) => l.includes('file_journal_by_run'))).toBe(true)
      expect(lines.some((l) => l.includes('TEMP B-TREE'))).toBe(false)
      expect(only(v32, () => read(v32)).some((l) => l.includes('TEMP B-TREE'))).toBe(true)
    }
  } finally { v32.close(); v33.close() }
})

test('writes on v33 keep the indexes whole: a run_finished written takes its run off the list, another event does not', () => {
  const { f, v33, v32 } = open()
  try {
    const ids = () => repo.runsWithoutFinishEvent(v33).map((r) => r.id)
    expect(ids()).toContain(f.unfinishedRun)
    expect(repo.insertEvent(v33, f.unfinishedRun, 5, 'run_finished', {})).not.toBeNull()
    expect(repo.insertEvent(v33, f.otherUnfinishedRun, 5, 'text_delta', { text: 'x' })).not.toBeNull()
    expect(ids()).not.toContain(f.unfinishedRun)
    expect(ids()).toContain(f.otherUnfinishedRun)
    const x = repo.insertExecution(v33, { run_id: null, workspace_id: f.ws2, tool_call_id: null, kind: 'command', command: 'true', cwd: '/synthetic', isolation: {}, network: false })
    expect(repo.listExecutions(v33, { workspace_id: f.ws2 }).at(-1)!.id).toBe(x.id)
    const j = repo.prepareJournalEntry(v33, { workspace_id: f.ws1, session_id: f.sid, run_id: f.runs.node, tool_call_id: null, path: 'g.txt', action: 'edited', before: null, before_sha: null, intended_sha: 'i' })
    repo.applyJournalEntry(v33, j.id, bytes(1), 'i')
    expect(repo.listJournal(v33, { run_id: f.runs.node }).at(-1)!.id).toBe(j.id)
    expect(v33.get('PRAGMA integrity_check')!.integrity_check).toBe('ok')
  } finally { v32.close(); v33.close() }
})
