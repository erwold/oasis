/** The database layer on a private copy of a real index.db: open (connect: PRAGMAs, ensureSchema — the migrations
 *  and the backup before an upgrade when the copy is older —, repairKnownColumns), the startup SQL of the reconcilers
 *  that touches no file and starts no process, backfillCallDetails, and the reads the app's pages make, through the
 *  production functions (src/db/repo.ts, src/director/call_details.ts).
 *
 *  Only the database layer runs: no app, no server, no workspace service, no journal recovery (it reads the files a
 *  journal names), no run reconciler (it signals processes), no credential store. run.sh runs it under a sandbox
 *  profile that refuses the network, every process but bun, reads of the person's home and data directory but this
 *  checkout and the private folder, and writes anywhere but the private folder.
 *
 *  Env: PERF_PRIVATE (holds index.db, the pristine copy, never written), PERF_OUT, PERF_SAMPLES (default 15),
 *  PERF_INIT_REPEATS (fresh clones opened, default 3). Every working copy is an APFS clone of the pristine one: its
 *  data blocks may be shared with the pristine copy at first, but the clone's metadata and every page written to it
 *  (a migration, a backfill, its WAL) take space — not zero. Output: function names, quantile labels, counts, milliseconds, the
 *  code's SQL and its query plans. */

import { closeSync, constants, copyFileSync, existsSync, openSync, readSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { connect, SCHEMA_VERSION, type Conn } from '../../src/db/database.ts'
import * as repo from '../../src/db/repo.ts'
import { backfillCallDetails } from '../../src/director/call_details.ts'
import { projectRoutes } from '../../src/api/projects.ts'
import type { Api } from '../../src/api/common.ts'
import { bench, dirFromEnv, fileBytes, fingerprint, intFromEnv, main, planOf, quantilePick, recordStatements, recordStatementsAsync, timeOnce, writeResult } from './common.ts'

const QS = [0.5, 0.9, 1]
const qLabel = (q: number) => (q === 1 ? 'max' : `p${Math.round(q * 100)}`)

function clone(pristine: string, dest: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dest + suffix, { force: true })
  copyFileSync(pristine, dest, constants.COPYFILE_FICLONE)
}

/** Keys chosen inside the process (never printed): the keys at the given quantiles of a count per key. */
function keysByCount(conn: Conn, sql: string): { q: number; key: string; count: number }[] {
  const rows = conn.all(sql).map((r) => ({ key: String(r.k), count: Number(r.n) })).sort((a, b) => a.count - b.count)
  return quantilePick(rows, QS).map(({ q, item }) => ({ q, key: item.key, count: item.count }))
}

// a real copy's error is never printed whole, whatever the environment says
delete process.env.PERF_DEBUG_SYNTHETIC
// the console is silenced by guard_preload.ts (PERF_SILENCE_CONSOLE=1, set by run.sh); refuse to run without it
const silenced = (globalThis as Record<string, unknown>).__perfSilenced as Record<string, number> | undefined
if (process.env.PERF_SILENCE_CONSOLE !== '1' || silenced === undefined) throw new Error('run through run.sh realdb (the console must be silenced)')

main(async () => {
  const priv = dirFromEnv('PERF_PRIVATE')
  const pristine = join(priv, 'index.db')
  if (!existsSync(pristine) || fileBytes(pristine + '-wal') > 0) throw new Error('PERF_PRIVATE must hold a closed index.db copy (copy_index_db.py)')
  const samples = intFromEnv('PERF_SAMPLES', 15)
  const result: Record<string, unknown> = { kind: 'real_db_copy', schema_version_code: SCHEMA_VERSION, fingerprint: fingerprint() }
  // the copy's schema version from its header (offset 60, big-endian): the pristine copy is never opened, so no
  // sidecar file is made beside it (a read-only open of a WAL database without one cannot start)
  const header = new Uint8Array(100)
  const fd = openSync(pristine, 'r')
  try { readSync(fd, header, 0, 100, 0) } finally { closeSync(fd) }
  result.copy_user_version = new DataView(header.buffer).getUint32(60)
  result.copy_bytes = fileBytes(pristine)

  // -- open: connect() on fresh clones (the first open of a copy is what a start after an upgrade pays) ---------------
  // the open of an APFS clone right after another: page cache warm; no app start, no cold disk
  const opens: { ms: number; wal_bytes_after: number; backup_bytes: number; user_version_after: number }[] = []
  const repeats = intFromEnv('PERF_INIT_REPEATS', 3)
  const backfills: { first_ms: number; first_completed: number }[] = []
  for (let i = 0; i < repeats; i += 1) {
    const work = join(priv, `work-open-${i}.db`)
    clone(pristine, work)
    const { ms, value: conn } = timeOnce(() => connect(work))
    const bak = `${work}.v${result.copy_user_version}.bak`
    opens.push({ ms, wal_bytes_after: fileBytes(`${work}-wal`), backup_bytes: fileBytes(bak), user_version_after: Number(conn.get('PRAGMA user_version')!.user_version) })
    const first = timeOnce(() => backfillCallDetails(conn))
    backfills.push({ first_ms: first.ms, first_completed: first.value })
    conn.close()
    for (const p of [work, `${work}-wal`, `${work}-shm`, bak]) rmSync(p, { force: true })
  }
  result.connect_fresh_clone = opens
  result.migrations_applied = Number(result.copy_user_version) < SCHEMA_VERSION
  result.backfill_call_details_first = backfills

  // the working copy every later measurement reads (opened once: the app's one connection)
  const work = join(priv, 'work.db')
  clone(pristine, work)
  const conn = connect(work)
  result.connect_reopen = (await bench(() => { connect(work).close() }, { n: Math.min(samples, 10) })).ms
  const steady = await bench(() => backfillCallDetails(conn), { n: Math.min(samples, 5) })
  result.backfill_call_details_steady = { ms: steady.ms, completed: steady.last, ...summarize(conn, () => backfillCallDetails(conn)) }

  // -- startup SQL of the reconcilers (reads only; none touches a file or a process) --------------------------------
  const startup: Record<string, unknown> = {}
  const startupCalls: Record<string, () => unknown> = {
    runsWithoutFinishEvent: () => repo.runsWithoutFinishEvent(conn),
    listRunsWithStatus_live: () => repo.listRunsWithStatus(conn, ['queued', 'running', 'waiting']),
    listPreparedJournal: () => repo.listPreparedJournal(conn),
    listRelaysWithStatus_running: () => repo.listRelaysWithStatus(conn, ['running']),
    listInteractionsWithStatus_live: () => repo.listInteractionsWithStatus(conn, ['planning', 'running', 'waiting']),
    activeUiTasks: () => repo.activeUiTasks(conn),
    pendingUiInputs: () => repo.pendingUiInputs(conn),
    listActiveWatches: () => repo.listActiveWatches(conn),
    listPendingWakeEvents: () => repo.listPendingWakeEvents(conn),
    remote_workspaces_of_main_start: () => conn.all('SELECT DISTINCT e.workspace_id FROM executions e JOIN remote_jobs r ON r.execution_id=e.id'),
  }
  for (const [name, fn] of Object.entries(startupCalls)) startup[name] = await measure(conn, fn, samples)
  result.startup_reads = startup

  // -- the pages' reads, on keys at the median, the 90th percentile and the largest -------------------------------------
  const reads: Record<string, unknown> = {}
  reads.listProjects = await measure(conn, () => repo.listProjects(conn), samples)
  // the projects page's route itself, in process (Hono's app.request: no listener, no port, no HTTP): its local time,
  // its statements and the bytes of the body it answers with
  {
    const routes = projectRoutes({ state: { conn } } as unknown as Api)
    const call = async () => { const res = await routes.request('/api/projects'); return { status: res.status, bytes: (await res.arrayBuffer()).byteLength } }
    const timed = await bench(call, { n: samples })
    const { statements } = await recordStatementsAsync(conn, call)
    reads['route GET /api/projects (in process)'] = { ms: timed.ms, status: timed.last.status, response_bytes: timed.last.bytes, statements: statements.length, plans: planOf(conn, statements) }
  }
  for (const p of keysByCount(conn, 'SELECT project_id AS k, count(*) AS n FROM sessions GROUP BY project_id')) {
    reads[`listSessions[project ${qLabel(p.q)}: ${p.count} sessions]`] = await measure(conn, () => repo.listSessions(conn, p.key), samples)
  }
  for (const s of keysByCount(conn, 'SELECT session_id AS k, count(*) AS n FROM runs GROUP BY session_id')) {
    const at = `session ${qLabel(s.q)}: ${s.count} runs`
    reads[`getSession[${at}]`] = await measure(conn, () => repo.getSession(conn, s.key), samples)
    reads[`listRuns[${at}]`] = await measure(conn, () => repo.listRuns(conn, s.key), samples)
    reads[`listThreadRuns[${at}]`] = await measure(conn, () => repo.listThreadRuns(conn, s.key), samples)
    reads[`latestRunOfSession[${at}]`] = await measure(conn, () => repo.latestRunOfSession(conn, s.key), samples)
    reads[`countRuns[${at}]`] = await measure(conn, () => repo.countRuns(conn, s.key), samples)
    reads[`listInteractions[${at}]`] = await measure(conn, () => repo.listInteractions(conn, s.key), samples)
    reads[`listRelays[${at}]`] = await measure(conn, () => repo.listRelays(conn, s.key), samples)
    reads[`listUiSurfaces[${at}]`] = await measure(conn, () => repo.listUiSurfaces(conn, s.key), samples)
    reads[`listDirectorNotes[${at}]`] = await measure(conn, () => repo.listDirectorNotes(conn, s.key), samples)
    reads[`listWatches[${at}]`] = await measure(conn, () => repo.listWatches(conn, s.key), samples)
  }
  for (const s of keysByCount(conn, 'SELECT session_id AS k, count(*) AS n FROM run_events GROUP BY session_id')) {
    const at = `session ${qLabel(s.q)}: ${s.count} events`
    reads[`sessionEventsAfter_page500[${at}]`] = await measure(conn, () => repo.sessionEventsAfter(conn, s.key, 0, Number.MAX_SAFE_INTEGER, 500), samples)
    reads[`listSessionEvents[${at}]`] = await measure(conn, () => repo.listSessionEvents(conn, s.key), Math.min(samples, 5))
  }
  for (const r of keysByCount(conn, 'SELECT run_id AS k, count(*) AS n FROM run_events GROUP BY run_id')) {
    const at = `run ${qLabel(r.q)}: ${r.count} events`
    reads[`listEvents[${at}]`] = await measure(conn, () => repo.listEvents(conn, r.key), samples)
    reads[`maxEventSeq[${at}]`] = await measure(conn, () => repo.maxEventSeq(conn, r.key), samples)
  }
  for (const r of keysByCount(conn, 'SELECT id AS k, coalesce(length(CAST(history_json AS BLOB)),0) AS n FROM runs')) {
    const at = `run ${qLabel(r.q)}: ${r.count} history bytes`
    reads[`getRun[${at}]`] = await measure(conn, () => repo.getRun(conn, r.key), samples)
    reads[`getRunHistory[${at}]`] = await measure(conn, () => repo.getRunHistory(conn, r.key), samples)
    reads[`listModelRequests[${at}]`] = await measure(conn, () => repo.listModelRequests(conn, r.key), samples)
    reads[`listExecutions_by_run[${at}]`] = await measure(conn, () => repo.listExecutions(conn, { run_id: r.key }), samples)
    reads[`listCheckpointsOfRun[${at}]`] = await measure(conn, () => repo.listCheckpointsOfRun(conn, r.key), samples)
    reads[`listJournal_by_run[${at}]`] = await measure(conn, () => repo.listJournal(conn, { run_id: r.key }), samples)
  }
  for (const w of keysByCount(conn, 'SELECT workspace_id AS k, count(*) AS n FROM executions WHERE workspace_id IS NOT NULL GROUP BY workspace_id')) {
    reads[`listExecutions_by_workspace[workspace ${qLabel(w.q)}: ${w.count} executions]`] = await measure(conn, () => repo.listExecutions(conn, { workspace_id: w.key }), samples)
  }
  for (const w of keysByCount(conn, 'SELECT workspace_id AS k, count(*) AS n FROM checkpoints GROUP BY workspace_id')) {
    const at = `workspace ${qLabel(w.q)}: ${w.count} checkpoints`
    reads[`listCheckpoints[${at}]`] = await measure(conn, () => repo.listCheckpoints(conn, w.key), samples)
    reads[`latestSnapshot[${at}]`] = await measure(conn, () => repo.latestSnapshot(conn, w.key), samples)
    const commit = conn.get('SELECT commit_sha FROM checkpoints WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1', [w.key])
    if (commit) reads[`listCheckpointsByCommit[${at}]`] = await measure(conn, () => repo.listCheckpointsByCommit(conn, String(commit.commit_sha)), samples)
  }
  for (const w of keysByCount(conn, 'SELECT workspace_id AS k, count(*) AS n FROM file_journal GROUP BY workspace_id')) {
    reads[`listJournal_by_workspace[workspace ${qLabel(w.q)}: ${w.count} entries]`] = await measure(conn, () => repo.listJournal(conn, { workspace_id: w.key }), Math.min(samples, 5))
  }
  result.reads = reads
  conn.close()
  for (const p of [work, `${work}-wal`, `${work}-shm`]) rmSync(p, { force: true })
  result.console_lines_silenced = silenced
  writeResult('real_db_bench', result)
})

/** Statement count (an N+1 shows as a count that grows with the rows) and each distinct statement's plan. */
function summarize(conn: Conn, fn: () => unknown): { statements: number; plans: ReturnType<typeof planOf> } {
  const { statements } = recordStatements(conn, fn)
  return { statements: statements.length, plans: planOf(conn, statements) }
}

async function measure(conn: Conn, fn: () => unknown, n: number): Promise<Record<string, unknown>> {
  const { ms, last } = await bench(fn, { n })
  const rows = Array.isArray(last) ? last.length : last === null || last === undefined ? 0 : 1
  return { ms, rows, ...summarize(conn, fn) }
}
