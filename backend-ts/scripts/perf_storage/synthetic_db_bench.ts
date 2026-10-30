/** The database layer on a synthetic database built through the production functions (src/db/repo.ts) in a scratch
 *  folder: the hypotheses that need sizes the real copy cannot be bent to.
 *
 *    n_plus_one     listSessions / listProjects: statements per call as sessions and roots grow (structural)
 *    wide_rows      listRuns / latestRunOfSession / getRun with history_json of 0, 64 KiB, 1 MiB: SELECT * reads the
 *                   overflow pages of a column the caller drops; beside it, the same rows by a projection that leaves
 *                   history_json out (labelled candidate: SQL of this script, not of the product)
 *    journal_scan   listJournal / settleJournalEntry with blobs of 1 KiB and 256 KiB: plans (undone_by has no index)
 *                   and milliseconds as the table grows
 *    unindexed      listCheckpointsByCommit, listExecutions by workspace, runsWithoutFinishEvent, listPreparedJournal,
 *                   markLostExecutions as the tables grow
 *    events_wal     insertEvent (one transaction per event): events/s; the -wal file's peak and final size, alone and
 *                   with a second connection holding a read transaction (checkpoints cannot reset the WAL meanwhile)
 *    run_writes     saveRunProgress (one UPDATE, autocommit) and finishRun (an UPDATE, then a SELECT, touchSession and
 *                   noteSessionActivity — several statements, each its own autocommit, no explicit transaction) with
 *                   history_json of 0, 64 KiB, 1 MiB, 6 MiB: whole-call ms, statements, the -wal file's physical peak
 *                   and growth; after the timing only, a PASSIVE checkpoint's frame counts (the WAL's backlog then)
 *    deletion       deleteSession (soft: status only) and the bytes it leaves; a candidate hard delete of the same
 *                   rows (this script's SQL, a proposal's cost, never the product's) and VACUUM: time and bytes freed
 *
 *  Env: PERF_SCRATCH, PERF_OUT, PERF_SCALE=small|large (default small), PERF_SAMPLES. No real data is read. */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { connect, type Conn } from '../../src/db/database.ts'
import * as repo from '../../src/db/repo.ts'
import { assertFree, bench, dirFromEnv, genBudgetBytes, fileBytes, fingerprint, intFromEnv, main, planOf, recordStatements, timeOnce, writeResult } from './common.ts'

const SCALE = process.env.PERF_SCALE === 'large' ? 'large' : 'small'
const RUN_WRITE_REPEATS = SCALE === 'large' ? 30 : 8
const S = SCALE === 'large'
  ? { sessions: [10, 100, 1000], runsPerSession: 50, eventsPerRun: 200, eventBytes: 600, journal: [1000, 20000], unindexed: [1000, 50000], walEvents: 20000 }
  : { sessions: [10, 100], runsPerSession: 10, eventsPerRun: 50, eventBytes: 600, journal: [200, 2000], unindexed: [200, 5000], walEvents: 5000 }

const pad = (n: number) => 'x'.repeat(n)
const pageCount = (conn: Conn) => Number(conn.get('PRAGMA page_count')!.page_count)
const freePages = (conn: Conn) => Number(conn.get('PRAGMA freelist_count')!.freelist_count)

function freshDb(dir: string, name: string): { conn: Conn; path: string } {
  const path = join(dir, `${name}.db`)
  for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true })
  return { conn: connect(path), path }
}

/** A PASSIVE checkpoint after a timing. Whether it was refused while the connection's cached statements were still
 *  open (SQLITE_LOCKED: a statement stepped by get() and not yet reset) is recorded; then the cache is cleared and the
 *  checkpoint asked again — the clearing is the harness's, not the product's. */
function passiveCheckpoint(conn: Conn): { locked_by_open_statements: boolean; busy: number; log_frames: number; checkpointed_frames: number } {
  let locked = false
  let row: Record<string, number> | null = null
  try { row = conn.get('PRAGMA wal_checkpoint(PASSIVE)') as Record<string, number> } catch (error) {
    if ((error as { code?: string }).code !== 'SQLITE_LOCKED') throw error
    locked = true
  }
  if (row === null) { (conn.db as unknown as { clearQueryCache(): void }).clearQueryCache(); row = conn.db.query('PRAGMA wal_checkpoint(PASSIVE)').get() as Record<string, number> }
  return { locked_by_open_statements: locked, busy: Number(row.busy), log_frames: Number(row.log), checkpointed_frames: Number(row.checkpointed) }
}

function dropDb(conn: Conn, path: string): void {
  conn.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
}

function project(conn: Conn): string {
  return repo.createProject(conn, 'synthetic', { source_path: null, base_repo_path: '/nonexistent/base.git', base_commit: 'c0', base_branch: 'main', import_report: {} }).id
}

function run(conn: Conn, sessionId: string, projectId: string, workspaceId: string | null = null): string {
  return repo.insertRun(conn, { session_id: sessionId, project_id: projectId, workspace_id: workspaceId, model: 'synthetic:model', model_config: {}, user_text: 'synthetic', status: 'running', budget: {} }).id
}

function analyze<T>(conn: Conn, fn: () => T) {
  const { statements } = recordStatements(conn, fn)
  return { statements: statements.length, plans: planOf(conn, statements) }
}

main(async () => {
  const scratch = dirFromEnv('PERF_SCRATCH')
  const samples = intFromEnv('PERF_SAMPLES', 15)
  const result: Record<string, unknown> = { kind: 'synthetic_db', scale: SCALE, sizes: S, fingerprint: fingerprint() }

  // -- n_plus_one ------------------------------------------------------------------------------------------------------
  const nPlusOne: Record<string, unknown>[] = []
  for (const sessions of S.sessions) {
    for (const roots of [0, 2]) {
      const { conn, path } = freshDb(scratch, `n1-${sessions}-${roots}`)
      const pid = project(conn)
      conn.transaction(() => {
        for (let i = 0; i < sessions; i += 1) {
          const sid = repo.createSession(conn, pid, `s${i}`, 'synthetic:model').id
          if (roots) repo.setSessionRoots(conn, sid, Array.from({ length: roots }, (_, k) => ({ path: `/synthetic/root-${i}-${k}`, access: 'read' as const })))
        }
      })
      nPlusOne.push({
        sessions, roots_per_session: roots,
        listSessions: { ms: (await bench(() => repo.listSessions(conn, pid), { n: samples })).ms, ...analyze(conn, () => repo.listSessions(conn, pid)) },
        listProjects: { ms: (await bench(() => repo.listProjects(conn), { n: samples })).ms, ...analyze(conn, () => repo.listProjects(conn)) },
      })
      dropDb(conn, path)
    }
  }
  result.n_plus_one = nPlusOne

  // -- wide_rows -------------------------------------------------------------------------------------------------------
  const wide: Record<string, unknown>[] = []
  for (const historyBytes of [0, 64 * 1024, 1024 * 1024]) {
    assertFree(scratch, S.runsPerSession * historyBytes * 3, 'wide_rows')
    const { conn, path } = freshDb(scratch, `wide-${historyBytes}`)
    const pid = project(conn)
    const sid = repo.createSession(conn, pid, 's', 'synthetic:model').id
    const history = historyBytes ? JSON.stringify([{ parts: [{ part_kind: 'text', content: pad(historyBytes) }] }]) : null
    let last = ''
    conn.transaction(() => {
      for (let i = 0; i < S.runsPerSession; i += 1) {
        last = run(conn, sid, pid)
        repo.finishRun(conn, last, 'done', { history_json: history, usage: {}, error: null, receipt: {}, saved_seq: 0 })
      }
    })
    // two candidates: columns stored before history_json only, and one stored after it (finished_at): a column after a
    // large value is reached through that value's overflow pages, whatever the projection
    const projection = 'SELECT id, session_id, status, created_at FROM runs WHERE session_id=? ORDER BY created_at'
    const projectionPast = 'SELECT id, session_id, status, created_at, finished_at FROM runs WHERE session_id=? ORDER BY created_at'
    wide.push({
      history_bytes: historyBytes, runs: S.runsPerSession, db_bytes: fileBytes(path),
      listRuns: { ms: (await bench(() => repo.listRuns(conn, sid), { n: samples })).ms, ...analyze(conn, () => repo.listRuns(conn, sid)) },
      latestRunOfSession: { ms: (await bench(() => repo.latestRunOfSession(conn, sid), { n: samples })).ms },
      getRun: { ms: (await bench(() => repo.getRun(conn, last), { n: samples })).ms },
      candidate_projection_not_production: { sql: projection, ms: (await bench(() => conn.all(projection, [sid]), { n: samples })).ms },
      candidate_projection_past_history_not_production: { sql: projectionPast, ms: (await bench(() => conn.all(projectionPast, [sid]), { n: samples })).ms },
    })
    dropDb(conn, path)
  }
  result.wide_rows = wide

  // -- journal_scan ----------------------------------------------------------------------------------------------------
  const journal: Record<string, unknown>[] = []
  for (const entries of S.journal) {
    for (const blob of [1024, 256 * 1024]) {
      // before and after are both kept whole: twice the blob per entry; a batch over the budget is skipped, and said
      const estimate = entries * blob * 2
      if (estimate > genBudgetBytes()) { journal.push({ entries, blob_bytes: blob, skipped: 'over the generated-data budget', estimate_bytes: estimate }); continue }
      assertFree(scratch, estimate, 'journal_scan')
      const { conn, path } = freshDb(scratch, `journal-${entries}-${blob}`)
      const pid = project(conn)
      const sid = repo.createSession(conn, pid, 's', 'synthetic:model').id
      const ws = repo.insertWorkspace(conn, 'ws_synthetic', pid, sid, '/synthetic/folder', '', '', 'direct')
      const rid = run(conn, sid, pid, ws.id)
      const bytes = new Uint8Array(blob).fill(97)
      let lastId = ''
      const build = timeOnce(() => conn.transaction(() => {
        for (let i = 0; i < entries; i += 1) {
          const e = repo.prepareJournalEntry(conn, { workspace_id: ws.id, session_id: sid, run_id: rid, tool_call_id: null, path: `f${i % 50}.txt`, action: 'edited', before: bytes, before_sha: 'b', intended_sha: 'a' })
          repo.applyJournalEntry(conn, e.id, bytes, 'a')
          lastId = e.id
        }
      }))
      const prepared = () => repo.prepareJournalEntry(conn, { workspace_id: ws.id, session_id: sid, run_id: rid, tool_call_id: null, path: 'g.txt', action: 'edited', before: null, before_sha: null, intended_sha: 'a' })
      const settleTimed = prepared(), settlePlanned = prepared()
      journal.push({
        entries, blob_bytes: blob, build_ms: build.ms, db_bytes: fileBytes(path) + fileBytes(`${path}-wal`),
        listJournal_workspace: { ms: (await bench(() => repo.listJournal(conn, { workspace_id: ws.id }), { n: Math.min(samples, 5) })).ms, ...analyze(conn, () => repo.listJournal(conn, { workspace_id: ws.id })) },
        listJournal_run: { ms: (await bench(() => repo.listJournal(conn, { run_id: rid }), { n: Math.min(samples, 5) })).ms },
        journalBytes_after: { ms: (await bench(() => repo.journalBytes(conn, lastId, 'after'), { n: samples })).ms },
        settleJournalEntry: { ms: timeOnce(() => repo.settleJournalEntry(conn, settleTimed.id, 'abandoned')).ms, ...analyze(conn, () => repo.settleJournalEntry(conn, settlePlanned.id, 'abandoned')) },
        listPreparedJournal: { ms: (await bench(() => repo.listPreparedJournal(conn), { n: samples })).ms, ...analyze(conn, () => repo.listPreparedJournal(conn)) },
      })
      dropDb(conn, path)
    }
  }
  result.journal_scan = journal

  // -- unindexed -------------------------------------------------------------------------------------------------------
  const unindexed: Record<string, unknown>[] = []
  for (const rows of S.unindexed) {
    const { conn, path } = freshDb(scratch, `unindexed-${rows}`)
    const pid = project(conn)
    const sid = repo.createSession(conn, pid, 's', 'synthetic:model').id
    const ws = repo.insertWorkspace(conn, 'ws_synthetic', pid, sid, '/synthetic/ws', 'b', 'c0')
    conn.transaction(() => {
      for (let i = 0; i < rows; i += 1) {
        const rid = run(conn, sid, pid, ws.id)
        repo.insertEvent(conn, rid, 0, 'run_started', {})
        if (i % 2) repo.insertEvent(conn, rid, 1, 'run_finished', {})
        repo.finishRun(conn, rid, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 1 })
        const x = repo.insertExecution(conn, { run_id: rid, workspace_id: ws.id, tool_call_id: null, kind: 'command', command: 'true', cwd: '/synthetic', isolation: {}, network: false })
        repo.finishExecution(conn, x.id, { status: 'exited', exit_code: 0, timed_out: false, cancelled: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 0, stderr_bytes: 0, duration_ms: 1 })
        const snap = repo.insertSnapshot(conn, ws.id, 'c0', `t${i}`, 1, [], [], [])
        repo.insertCheckpoint(conn, `cp_${i}`, ws.id, rid, snap.id, `sha${i}`, `refs/oasis-code/checkpoints/cp_${i}`, null, '')
      }
    })
    const calls: Record<string, () => unknown> = {
      listCheckpointsByCommit: () => repo.listCheckpointsByCommit(conn, `sha${rows - 1}`),
      listExecutions_by_workspace: () => repo.listExecutions(conn, { workspace_id: ws.id }),
      runsWithoutFinishEvent: () => repo.runsWithoutFinishEvent(conn),
      listPreparedJournal: () => repo.listPreparedJournal(conn),
      markLostExecutions: () => repo.markLostExecutions(conn),
      latestCheckpoint: () => repo.latestCheckpoint(conn, ws.id),
    }
    const row: Record<string, unknown> = { rows }
    for (const [name, fn] of Object.entries(calls)) row[name] = { ms: (await bench(fn, { n: samples })).ms, ...analyze(conn, fn) }
    unindexed.push(row)
    dropDb(conn, path)
  }
  result.unindexed = unindexed

  // -- events_wal ------------------------------------------------------------------------------------------------------
  const wal: Record<string, unknown>[] = []
  for (const reader of [false, true]) {
    // the WAL with a reader holding a snapshot grew ~24 KB per event in the dry run: budget for it
    assertFree(scratch, S.walEvents * 32 * 1024, 'events_wal')
    const { conn, path } = freshDb(scratch, `wal-${reader}`)
    const pid = project(conn)
    const sid = repo.createSession(conn, pid, 's', 'synthetic:model').id
    const rid = run(conn, sid, pid)
    const other = reader ? new Database(path) : null
    if (other) { other.run('BEGIN'); other.query('SELECT count(*) FROM runs').get() }
    const data = { text: pad(S.eventBytes) }
    let peak = 0
    const t0 = performance.now()
    for (let i = 0; i < S.walEvents; i += 1) {
      repo.insertEvent(conn, rid, i, 'text_delta', data)
      if (i % 500 === 0) peak = Math.max(peak, fileBytes(`${path}-wal`))
    }
    const ms = performance.now() - t0
    peak = Math.max(peak, fileBytes(`${path}-wal`))
    // after the timing, the reader still holding its snapshot: the frames a PASSIVE checkpoint could not move (backlog);
    // the WAL file's physical size is a high-water mark, a separate thing — and no app reader is implied by either
    const backlog = passiveCheckpoint(conn)
    if (other) { other.run('COMMIT'); other.close() }
    repo.insertEvent(conn, rid, S.walEvents, 'text_delta', data)
    wal.push({ concurrent_reader: reader, events: S.walEvents, event_bytes: S.eventBytes, events_per_s: Math.round(S.walEvents / (ms / 1000)), wal_peak_bytes: peak,
      wal_after_reader_ended_bytes: fileBytes(`${path}-wal`), db_bytes: fileBytes(path),
      passive_while_reader_held: backlog })
    dropDb(conn, path)
  }
  result.events_wal = wal

  // -- run_writes ------------------------------------------------------------------------------------------------------
  const writes: Record<string, unknown>[] = []
  for (const historyBytes of [0, 64 * 1024, 1024 * 1024, 6 * 1024 * 1024]) {
    // each call writes the history once into the WAL (and the table once it is checkpointed): budget twice that per call
    const estimate = RUN_WRITE_REPEATS * 2 * (historyBytes + 64 * 1024) * 2 * 2
    if (estimate > genBudgetBytes()) { writes.push({ history_bytes: historyBytes, skipped: 'over the generated-data budget', estimate_bytes: estimate }); continue }
    assertFree(scratch, estimate, 'run_writes')
    const { conn, path } = freshDb(scratch, `writes-${historyBytes}`)
    const pid = project(conn)
    const sid = repo.createSession(conn, pid, 's', 'synthetic:model').id
    const history = historyBytes ? JSON.stringify([{ parts: [{ part_kind: 'text', content: pad(historyBytes) }] }]) : null
    const usage = { input_tokens: 1, output_tokens: 1 }
    const rid = run(conn, sid, pid)
    conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const walStart = fileBytes(`${path}-wal`)
    let peak = walStart
    let seq = 0
    const save = await bench(() => { repo.saveRunProgress(conn, rid, history, usage, seq += 1); peak = Math.max(peak, fileBytes(`${path}-wal`)) }, { n: RUN_WRITE_REPEATS, warmup: 1 })
    const saveStatements = analyze(conn, () => repo.saveRunProgress(conn, rid, history, usage, seq += 1))
    const finishIds = Array.from({ length: RUN_WRITE_REPEATS + 2 }, () => run(conn, sid, pid))
    let k = 0
    const finish = await bench(() => { repo.finishRun(conn, finishIds[k++]!, 'done', { history_json: history, usage, error: null, receipt: {}, saved_seq: 1 }); peak = Math.max(peak, fileBytes(`${path}-wal`)) }, { n: RUN_WRITE_REPEATS, warmup: 1 })
    const finishStatements = analyze(conn, () => repo.finishRun(conn, finishIds[k++]!, 'done', { history_json: history, usage, error: null, receipt: {}, saved_seq: 1 }))
    const walEnd = fileBytes(`${path}-wal`)
    // after the timing: what a PASSIVE checkpoint finds (busy, frames in the WAL, frames it moved) — the backlog then
    const passive = passiveCheckpoint(conn)
    writes.push({
      history_bytes: historyBytes, repeats: RUN_WRITE_REPEATS,
      saveRunProgress: { ms: save.ms, statements: saveStatements.statements, plans: saveStatements.plans },
      finishRun: { ms: finish.ms, statements: finishStatements.statements, plans: finishStatements.plans, explicit_transaction: false },
      wal: { start_bytes: walStart, physical_peak_bytes: peak, end_bytes: walEnd, growth_bytes: walEnd - walStart,
        passive_after_timing: passive },
    })
    dropDb(conn, path)
  }
  result.run_writes = writes

  // -- deletion --------------------------------------------------------------------------------------------------------
  {
    assertFree(scratch, 20 * S.runsPerSession * (S.eventsPerRun * (S.eventBytes + 200) + 17 * 1024) * 3, 'deletion')
    const { conn, path } = freshDb(scratch, 'deletion')
    const pid = project(conn)
    const sessions: string[] = []
    conn.transaction(() => {
      for (let i = 0; i < 20; i += 1) {
        const sid = repo.createSession(conn, pid, `s${i}`, 'synthetic:model').id
        sessions.push(sid)
        for (let r = 0; r < S.runsPerSession; r += 1) {
          const rid = run(conn, sid, pid)
          for (let e = 0; e < S.eventsPerRun; e += 1) repo.insertEvent(conn, rid, e, 'text_delta', { text: pad(S.eventBytes) })
          repo.finishRun(conn, rid, 'done', { history_json: JSON.stringify([pad(16 * 1024)]), usage: {}, error: null, receipt: {}, saved_seq: 0 })
        }
      }
    })
    conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const before = { pages: pageCount(conn), free: freePages(conn), bytes: fileBytes(path) }
    const doomed = sessions.slice(0, 10)
    const soft = timeOnce(() => { for (const sid of doomed) repo.deleteSession(conn, sid) })
    conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const afterSoft = { pages: pageCount(conn), free: freePages(conn), bytes: fileBytes(path) }
    const marks = doomed.map(() => '?').join(',')
    const candidate = [
      `DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE session_id IN (${marks}))`,
      `DELETE FROM run_collab WHERE session_id IN (${marks})`,
      `DELETE FROM runs WHERE session_id IN (${marks})`,
      `DELETE FROM sessions WHERE id IN (${marks})`,
    ]
    const hard = timeOnce(() => conn.transaction(() => { for (const sql of candidate) conn.run(sql, doomed) }))
    conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const afterHard = { pages: pageCount(conn), free: freePages(conn), bytes: fileBytes(path) }
    const vacuum = timeOnce(() => conn.exec('VACUUM'))
    const afterVacuum = { pages: pageCount(conn), free: freePages(conn), bytes: fileBytes(path) }
    result.deletion = { sessions: sessions.length, deleted: doomed.length, before, soft_delete_ms: soft.ms, after_soft: afterSoft,
      candidate_hard_delete_not_production: { sql: candidate, ms: hard.ms, after: afterHard }, vacuum_ms: vacuum.ms, after_vacuum: afterVacuum }
    dropDb(conn, path)
  }

  writeResult(`synthetic_db_bench_${SCALE}`, result)
})
