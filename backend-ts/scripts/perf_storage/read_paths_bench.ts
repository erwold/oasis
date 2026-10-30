/** Schema v33's read paths measured against v32 with the frozen method of the storage audit (common.ts: `bench`,
 *  `stats`, `recordStatements`, `planOf`; keys at the median, the 90th percentile and the largest, chosen inside the
 *  process and never written). The same production function is called in every cell; only the schema of the copy and
 *  the SQL (read_paths_baseline.ts) change:
 *
 *    baseline         v32 schema, v32 SQL          (a4dc9ca)
 *    projection_only  v32 schema, v33 SQL
 *    index_only       v33 schema, v32 SQL
 *    combined         v33 schema, v33 SQL          (this branch)
 *    baseline_again   v32 schema, v32 SQL          (the drift over the case, A…A)
 *
 *  Each cell's result is compared with the baseline's in memory (isDeepStrictEqual): only the boolean is written.
 *
 *  Sections (PERF_READPATHS_SECTIONS, comma separated):
 *    ab          the four cells on every reader v33 touches, and the two remote reads (remote_order: their plans, and
 *                whether their rows come in v32's order on v33 — the evidence for an explicit ORDER BY, see
 *                REMOTE_ORDER_CANDIDATES; their time on both, which v33 does not set out to improve)
 *    variants    synthetic only: the index sets side by side — v32, v33 (partial run_finished index, the product),
 *                v33 with the compound run_events(run_id, event) instead, v33 keeping the run_id-only journal index
 *                beside the new one: CREATE ms, index bytes, plans, reads, equality, and the cost of the writes the
 *                indexes add to (insertEvent of other events and of run_finished, insertExecution + finishExecution,
 *                prepareJournalEntry + applyJournalEntry)
 *    upgrade     connect() on a fresh copy at v32: the first start of this build — the VACUUM INTO backup and the v33
 *                step, whole wall time, the peak bytes on disk while it runs (a sampling worker), the backup's bytes;
 *                then the steady reopen
 *    growth      synthetic only: saveRunProgress with a history that grows by one synthetic tool turn per call (each
 *                string built before its call, outside the timing): ms per call, the WAL after each call with no
 *                checkpoint by this script, then, labelled as such, one PASSIVE checkpoint and one more write
 *
 *  Modes (PERF_MODE):
 *    synthetic   builds a v32 database through the production writers in PERF_SCRATCH (default sections: all)
 *    real        PERF_PRIVATE/index.db: a closed copy made by the audit's own harness, at v32, never opened; every
 *                measurement is on a clone of it in the same folder (rp-*.db), removed with its -wal, -shm and the
 *                .v32.bak / .partial its upgrade made, and nothing else (default sections: ab). The console must be
 *                silenced (guard_preload.ts, PERF_SILENCE_CONSOLE=1). No app, no reconciler, no workspace, no path a
 *                record names; output is labels, counts, milliseconds, bytes, booleans, SQL of the code and plans.
 *
 *  Run through run_read_paths.sh. Output: PERF_OUT/read_paths_<mode>[_<scale>].json. */

import { closeSync, constants, copyFileSync, existsSync, openSync, readSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { connect, MIGRATIONS, SCHEMA_VERSION, splitStatements, type Conn, type Param } from '../../src/db/database.ts'
import * as repo from '../../src/db/repo.ts'
import {
  assertFree, bench, dirFromEnv, fileBytes, fingerprint, freeBytes, genBudgetBytes, intFromEnv, main, planOf, quantilePick,
  recordStatements, stats, timeOnce, writeResult, type Recorded, type Stats,
} from './common.ts'
import {
  openWithoutUpgrade, REMOTE_ORDER_CANDIDATES, rewindToV32, V32_REMOTE_EXECUTION_WORKSPACES_SQL, V32_REMOTE_EXECUTIONS_OF_WORKSPACE_SQL,
  V33_INDEXES, withSql, type SqlMode,
} from './read_paths_baseline.ts'

const MODE = process.env.PERF_MODE === 'real' ? 'real' : 'synthetic'
const SCALE = process.env.PERF_SCALE === 'large' ? 'large' : process.env.PERF_SCALE === 'smoke' ? 'smoke' : 'small'
if (MODE === 'real') {
  delete process.env.PERF_DEBUG_SYNTHETIC
  const silenced = (globalThis as Record<string, unknown>).__perfSilenced
  if (process.env.PERF_SILENCE_CONSOLE !== '1' || silenced === undefined) throw new Error('real mode runs through run_read_paths.sh real (the console must be silenced)')
}
const SECTIONS = new Set((process.env.PERF_READPATHS_SECTIONS || (MODE === 'real' ? 'ab' : 'ab,variants,upgrade,growth')).split(',').map((s) => s.trim()).filter(Boolean))
if (MODE === 'real' && (SECTIONS.has('variants') || SECTIONS.has('growth'))) throw new Error('variants and growth are synthetic only')

const QS = [0.5, 0.9, 1]
const qLabel = (q: number) => (q === 1 ? 'max' : `p${Math.round(q * 100)}`)
const OWNED_SUFFIXES = ['', '-wal', '-shm', '.v32.bak', '.v32.bak.partial']

const S = SCALE === 'smoke'
  // the harness's own check (sandbox, guard, cleanup): its numbers are not results
  ? { sessions: 4, runsPattern: [3, 5, 8, 12], eventsPerRun: 4, execPattern: [5, 9, 12, 3], remoteJobs: 10, journalEntries: 60, journalMaxRun: 30, journalBlob: 4 * 1024, bigHistories: 1, writes: 50, growthTurns: 10, growthTurnBytes: 1024 }
  : SCALE === 'large'
  ? { sessions: 100, runsPattern: [10, 50, 140, 300], eventsPerRun: 6, execPattern: [48, 140, 289, 10], remoteJobs: 200, journalEntries: 2000, journalMaxRun: 1000, journalBlob: 256 * 1024, bigHistories: 3, writes: 10000, growthTurns: 300, growthTurnBytes: 16 * 1024 }
  : { sessions: 20, runsPattern: [10, 50, 140, 300], eventsPerRun: 6, execPattern: [48, 140, 289, 10], remoteJobs: 50, journalEntries: 2000, journalMaxRun: 1000, journalBlob: 64 * 1024, bigHistories: 3, writes: 2000, growthTurns: 150, growthTurnBytes: 8 * 1024 }

/** Remove a working copy this script made, with what SQLite and an upgrade made beside it; nothing else. */
function removeOwned(path: string): void {
  for (const s of OWNED_SUFFIXES) rmSync(path + s, { force: true })
}

function clone(src: string, dest: string): void {
  removeOwned(dest)
  copyFileSync(src, dest, constants.COPYFILE_FICLONE)
}

function headerVersion(path: string): number {
  const header = new Uint8Array(100)
  const fd = openSync(path, 'r')
  try { readSync(fd, header, 0, 100, 0) } finally { closeSync(fd) }
  return new DataView(header.buffer).getUint32(60)
}

/** Schema changes and checkpoints refuse to run while the connection's cached statements are open (the audit's
 *  candidate bench found it): the harness finalizes its cache first; every later timing warms up again. */
function quiesce(conn: Conn): void {
  (conn.db as unknown as { clearQueryCache(): void }).clearQueryCache()
}

function keysByCount(conn: Conn, sql: string): { q: number; key: string; count: number }[] {
  const rows = conn.all(sql).map((r) => ({ key: String(r.k), count: Number(r.n) })).sort((a, b) => a.count - b.count)
  return quantilePick(rows, QS).map(({ q, item }) => ({ q, key: item.key, count: item.count }))
}

/** Bytes of each named index (dbstat), or null where this SQLite has no dbstat. */
function indexBytes(conn: Conn, names: string[]): Record<string, number> | null {
  try {
    const out: Record<string, number> = {}
    for (const name of names) out[name] = Number(conn.get('SELECT coalesce(sum(pgsize), 0) AS b FROM dbstat WHERE name=?', [name])!.b)
    return out
  } catch { return null }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// -- the synthetic v32 database -----------------------------------------------------------------------------------------

/** A database as a v32 build would leave it, written through the production writers: sessions of 10–300 runs with
 *  histories of 0 B to 6 MiB, runs that ended with and without run_finished, workspaces of 10–289 commands (some on a
 *  remote host, their jobs written out of order), a journal with one run of journalMaxRun entries, entries in every
 *  state and undos; created_at ties throughout (runs, commands, journal entries in groups). */
function buildSyntheticV32(path: string): Record<string, number> {
  removeOwned(path)
  const conn = connect(path)
  const rnd = mulberry32(33)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!
  const pid = repo.createProject(conn, 'synthetic', { source_path: null, base_repo_path: '/synthetic/base.git', base_commit: 'c0', base_branch: 'main', import_report: {} }).id
  const histories = [0, 0, 0, 0, 4 * 1024, 4 * 1024, 4 * 1024, 4 * 1024, 64 * 1024, 64 * 1024, 64 * 1024, 256 * 1024]
  const history = (bytes: number) => (bytes ? JSON.stringify([{ role: 'user', parts: [{ part_kind: 'text', content: 'h'.repeat(bytes) }] }]) : null)
  const workspaces: string[] = []
  const runsOf: string[][] = []
  let runCount = 0
  conn.transaction(() => {
    for (let i = 0; i < S.sessions; i += 1) {
      const sid = repo.createSession(conn, pid, `s${i}`, 'synthetic:model').id
      const ws = repo.insertWorkspace(conn, `ws_rp_${String(i).padStart(4, '0')}`, pid, sid, `/synthetic/ws-${i}`, 'b', 'c0').id
      workspaces.push(ws)
      const runs: string[] = []
      let tie = ''
      for (let k = 0; k < S.runsPattern[i % S.runsPattern.length]!; k += 1) {
        const rid = repo.insertRun(conn, { session_id: sid, project_id: pid, workspace_id: rnd() < 0.8 ? ws : null, model: 'synthetic:model', model_config: {}, user_text: 'synthetic', status: 'running', budget: {},
          label: rnd() < 0.3 ? 'labelled' : null, relay_id: rnd() < 0.05 ? `relay_rp_${i}` : null, interaction_id: rnd() < 0.05 ? `ix_rp_${i}` : null }).id
        runs.push(rid)
        runCount += 1
        repo.insertEvent(conn, rid, 0, 'run_started', {})
        for (let e = 1; e < S.eventsPerRun - 1; e += 1) repo.insertEvent(conn, rid, e, 'text_delta', { text: 'x'.repeat(200) })
        const status = k === 0 ? 'running' : pick(['done', 'done', 'done', 'error', 'cancelled'] as const)
        if (status !== 'running') {
          repo.finishRun(conn, rid, status, { history_json: history(pick(histories)), usage: { input_tokens: 1 }, error: status === 'error' ? 'synthetic error' : null, receipt: {}, saved_seq: 1 })
          if (rnd() < 0.9) repo.insertEvent(conn, rid, S.eventsPerRun - 1, 'run_finished', {})
        }
        if (k % 5 === 0) tie = String(conn.get('SELECT created_at FROM runs WHERE id=?', [rid])!.created_at)
        else if (k % 5 === 1) conn.run('UPDATE runs SET created_at=? WHERE id=?', [tie, rid])
      }
      runsOf.push(runs)
    }
    // the largest histories, on runs of the largest session
    const big = runsOf[3 % runsOf.length]!
    for (let b = 0; b < S.bigHistories; b += 1) repo.finishRun(conn, big[1 + b]!, 'done', { history_json: history(6 * 1024 * 1024), usage: {}, error: null, receipt: {}, saved_seq: 1 })
  })
  const executions: string[] = []
  conn.transaction(() => {
    workspaces.forEach((ws, i) => {
      let tie = ''
      for (let k = 0; k < S.execPattern[i % S.execPattern.length]!; k += 1) {
        const x = repo.insertExecution(conn, { run_id: rnd() < 0.7 ? runsOf[i]![k % runsOf[i]!.length]! : null, workspace_id: ws, tool_call_id: rnd() < 0.5 ? `tc_${k}` : null, kind: 'command', command: 'true', cwd: '/synthetic', isolation: {}, network: false }).id
        executions.push(x)
        if (rnd() < 0.9) repo.finishExecution(conn, x, { status: 'exited', exit_code: 0, timed_out: false, cancelled: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 1, stderr_bytes: 0, duration_ms: 1 })
        if (k % 3 === 0) tie = String(conn.get('SELECT created_at FROM executions WHERE id=?', [x])!.created_at)
        else conn.run('UPDATE executions SET created_at=? WHERE id=?', [tie, x])
      }
    })
    for (let k = 0; k < 20; k += 1) executions.push(repo.insertExecution(conn, { run_id: null, workspace_id: null, tool_call_id: null, kind: 'command', command: 'true', cwd: '/synthetic', isolation: {}, network: false }).id)
    conn.run("INSERT INTO ssh_targets (id, label, destination, created_at) VALUES ('tgt_rp', 'synthetic', 'synthetic-host', '2026-01-01T00:00:00.000Z')")
    const remote = [...executions].sort(() => rnd() - 0.5).slice(0, S.remoteJobs)
    remote.forEach((xid, k) => conn.run("INSERT INTO remote_jobs (execution_id, target_id, root_id, generation, operation_id) VALUES (?, 'tgt_rp', 'root_rp', 'g1', ?)", [xid, `op_${k}`]))
  })
  // the journal: run 0 of session 0 holds journalMaxRun entries, a few more runs the rest; written in batches
  const ws0 = workspaces[0]!
  const journalRuns = [runsOf[0]![0]!, runsOf[0]![1 % runsOf[0]!.length]!, runsOf[1 % runsOf.length]![0]!, runsOf[2 % runsOf.length]![0]!]
  const blob = new Uint8Array(S.journalBlob).fill(97)
  let written = 0
  let tie = ''
  const applied: string[] = []
  while (written < S.journalEntries) {
    conn.transaction(() => {
      for (let b = 0; b < 100 && written < S.journalEntries; b += 1, written += 1) {
        const run = written < S.journalMaxRun ? journalRuns[0]! : journalRuns[1 + (written % 3)]!
        const undo = rnd() < 0.03 && applied.length > 0
        const e = repo.prepareJournalEntry(conn, { workspace_id: ws0, session_id: null, run_id: undo ? null : run, tool_call_id: undo ? null : `tc_${written}`, path: `f${written % 50}.txt`, action: 'edited',
          before: rnd() < 0.1 ? null : blob, before_sha: 'b', intended_sha: 'a', undoes: undo ? [applied[applied.length - 1]!] : undefined })
        const state = rnd()
        if (state < 0.85) { repo.applyJournalEntry(conn, e.id, rnd() < 0.05 ? null : blob, 'a'); applied.push(e.id) }
        else if (state < 0.92) repo.settleJournalEntry(conn, e.id, 'unsettled')
        else if (state < 0.96) repo.settleJournalEntry(conn, e.id, 'abandoned')
        if (written % 4 === 0) tie = e.created_at
        else conn.run('UPDATE file_journal SET created_at=? WHERE id=?', [tie, e.id])
      }
    })
  }
  rewindToV32(conn)
  conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
  const counts = Object.fromEntries(['runs', 'run_events', 'executions', 'remote_jobs', 'file_journal'].map((t) => [t, Number(conn.get(`SELECT count(*) AS n FROM ${t}`)!.n)]))
  conn.close()
  return { ...counts, runs_written: runCount, db_bytes: fileBytes(path) }
}

// -- ab: the four cells ------------------------------------------------------------------------------------------------

interface Case { name: string; at: string; n: number; call: (c: Conn) => unknown }

function cases(conn: Conn, samples: number): Case[] {
  const out: Case[] = []
  for (const s of keysByCount(conn, 'SELECT session_id AS k, count(*) AS n FROM runs GROUP BY session_id')) {
    const at = `session ${qLabel(s.q)}: ${s.count} runs`
    out.push({ name: 'listRuns', at, n: samples, call: (c) => repo.listRuns(c, s.key) })
    out.push({ name: 'listThreadRuns', at, n: samples, call: (c) => repo.listThreadRuns(c, s.key) })
    out.push({ name: 'latestRunOfSession', at, n: samples, call: (c) => repo.latestRunOfSession(c, s.key) })
  }
  for (const r of keysByCount(conn, 'SELECT id AS k, coalesce(length(CAST(history_json AS BLOB)),0) AS n FROM runs')) {
    const at = `run ${qLabel(r.q)}: ${r.count} history bytes`
    out.push({ name: 'getRun', at, n: samples, call: (c) => repo.getRun(c, r.key) })
    out.push({ name: 'getRunHistory', at, n: samples, call: (c) => repo.getRunHistory(c, r.key) })
  }
  out.push({ name: 'runsWithoutFinishEvent', at: 'all runs', n: samples, call: (c) => repo.runsWithoutFinishEvent(c) })
  out.push({ name: 'listRunsWithStatus_live', at: 'all runs', n: samples, call: (c) => repo.listRunsWithStatus(c, ['queued', 'running', 'waiting']) })
  for (const w of keysByCount(conn, 'SELECT workspace_id AS k, count(*) AS n FROM executions WHERE workspace_id IS NOT NULL GROUP BY workspace_id')) {
    out.push({ name: 'listExecutions_by_workspace', at: `workspace ${qLabel(w.q)}: ${w.count} executions`, n: samples, call: (c) => repo.listExecutions(c, { workspace_id: w.key }) })
  }
  for (const r of keysByCount(conn, 'SELECT run_id AS k, count(*) AS n FROM file_journal WHERE run_id IS NOT NULL GROUP BY run_id')) {
    const at = `run ${qLabel(r.q)}: ${r.count} journal entries`
    out.push({ name: 'listJournal_by_run', at, n: Math.min(samples, 5), call: (c) => repo.listJournal(c, { run_id: r.key }) })
    out.push({ name: 'listPreparedJournal_of_run', at, n: samples, call: (c) => repo.listPreparedJournal(c, r.key) })
    out.push({ name: 'listUnsettledJournal', at, n: samples, call: (c) => repo.listUnsettledJournal(c, r.key) })
  }
  for (const w of keysByCount(conn, 'SELECT workspace_id AS k, count(*) AS n FROM file_journal GROUP BY workspace_id')) {
    const at = `workspace ${qLabel(w.q)}: ${w.count} journal entries`
    out.push({ name: 'listJournal_by_workspace', at, n: Math.min(samples, 5), call: (c) => repo.listJournal(c, { workspace_id: w.key }) })
    out.push({ name: 'listJournalUndos', at, n: samples, call: (c) => repo.listJournalUndos(c, w.key, '') })
  }
  out.push({ name: 'listPreparedJournal', at: 'all entries', n: samples, call: (c) => repo.listPreparedJournal(c) })
  for (const e of keysByCount(conn, 'SELECT id AS k, coalesce(length(before_blob),0) + coalesce(length(after_blob),0) AS n FROM file_journal')) {
    const at = `entry ${qLabel(e.q)}: ${e.count} blob bytes`
    out.push({ name: 'getJournalEntry', at, n: samples, call: (c) => repo.getJournalEntry(c, e.key) })
    out.push({ name: 'journalBytes_before', at, n: samples, call: (c) => repo.journalBytes(c, e.key, 'before') })
  }
  return out
}

async function measureCell(conn: Conn, mode: SqlMode, fn: () => unknown, n: number): Promise<{ ms: Stats; statements: number; plans: ReturnType<typeof planOf> }> {
  const { ms } = await bench(() => withSql(conn, mode, fn), { n })
  const { statements } = recordStatements(conn, () => withSql(conn, mode, fn))
  return { ms, statements: statements.length, plans: planOf(conn, statements) }
}

async function sectionAb(src: string, dir: string, samples: number): Promise<Record<string, unknown>> {
  const v32Path = join(dir, 'rp-ab-v32.db'), v33Path = join(dir, 'rp-ab-v33.db')
  clone(src, v32Path)
  clone(src, v33Path)
  const v32 = openWithoutUpgrade(v32Path)
  // the v33 copy upgraded by the product (connect): its backup is removed at once, its size kept
  const opened = timeOnce(() => connect(v33Path))
  const v33 = opened.value
  const backupBytes = fileBytes(`${v33Path}.v32.bak`)
  rmSync(`${v33Path}.v32.bak`, { force: true })
  const out: Record<string, unknown> = {
    v32_user_version: Number(v32.get('PRAGMA user_version')!.user_version), v33_user_version: Number(v33.get('PRAGMA user_version')!.user_version),
    upgrade_on_warm_clone: { ms: opened.ms, backup_bytes: backupBytes, note: 'the clone right after another: page cache warm; the first-start measurement is the upgrade section' },
  }
  const list = cases(v32, samples)
  const rows: Record<string, unknown> = {}
  for (const c of list) {
    const key = `${c.name}[${c.at}]`
    const baselineValue = withSql(v32, 'v32', () => c.call(v32))
    const cells: [string, Conn, SqlMode][] = [['baseline', v32, 'v32'], ['projection_only', v32, 'v33'], ['index_only', v33, 'v32'], ['combined', v33, 'v33'], ['baseline_again', v32, 'v32']]
    const row: Record<string, unknown> = {}
    const equal: Record<string, boolean> = {}
    for (const [cell, conn, mode] of cells) {
      row[cell] = await measureCell(conn, mode, () => c.call(conn), c.n)
      if (cell !== 'baseline' && cell !== 'baseline_again') equal[cell] = isDeepStrictEqual(withSql(conn, mode, () => c.call(conn)), baselineValue)
    }
    const combinedPlans = (row.combined as { plans: { plan: string[] }[] }).plans
    row.adopted_in_combined = V33_INDEXES.filter((name) => combinedPlans.some((p) => p.plan.some((line) => line.includes(name))))
    row.output_equal_to_baseline = equal
    rows[key] = row
  }
  out.cases = rows
  out.remote_order = await remoteOrder(v32, v33, samples)
  v32.close(); v33.close()
  removeOwned(v32Path); removeOwned(v33Path)
  return out
}

/** The two remote reads (no ORDER BY): their plans on v32 and v33, whether v33 returns v32's rows in v32's order, and
 *  which explicit order (REMOTE_ORDER_CANDIDATES) returns v32's order on both. Their time on both is reported apart:
 *  v33 does not set out to make them faster. */
async function remoteOrder(v32: Conn, v33: Conn, samples: number): Promise<Record<string, unknown>> {
  const one = (sql: string, params: Param[] = []): Recorded[] => [{ sql, params, kind: 'all' }]
  const workspaces = (c: Conn, sql: string) => [...new Set(c.all(sql).map((r) => String(r.workspace_id)))]
  const commands = (c: Conn, sql: string, ws: string) => c.all(sql, [ws]).map((r) => String(r.execution_id))
  const sameSet = (a: string[], b: string[]) => isDeepStrictEqual([...a].sort(), [...b].sort())
  const out: Record<string, unknown> = { remote_jobs: Number(v32.get('SELECT count(*) AS n FROM remote_jobs')!.n) }
  {
    const before = workspaces(v32, V32_REMOTE_EXECUTION_WORKSPACES_SQL), after = workspaces(v33, repo.REMOTE_EXECUTION_WORKSPACES_SQL)
    const candidates: Record<string, unknown> = {}
    for (const [name, sql] of Object.entries(REMOTE_ORDER_CANDIDATES.workspaces)) {
      candidates[name] = { order_equal_to_v32_on_v32: isDeepStrictEqual(workspaces(v32, sql), before), order_equal_to_v32_on_v33: isDeepStrictEqual(workspaces(v33, sql), before), plan_v33: planOf(v33, one(sql))[0]!.plan,
        ms_v33: (await bench(() => v33.all(sql), { n: samples })).ms }
    }
    out.workspaces_of_a_start = { rows: before.length, plan_v32: planOf(v32, one(V32_REMOTE_EXECUTION_WORKSPACES_SQL))[0]!.plan, plan_v33: planOf(v33, one(repo.REMOTE_EXECUTION_WORKSPACES_SQL))[0]!.plan,
      same_rows: sameSet(before, after), same_order: isDeepStrictEqual(before, after),
      ms_v32: (await bench(() => v32.all(V32_REMOTE_EXECUTION_WORKSPACES_SQL), { n: samples })).ms, ms_v33: (await bench(() => v33.all(repo.REMOTE_EXECUTION_WORKSPACES_SQL), { n: samples })).ms, candidates }
  }
  const keys = keysByCount(v32, 'SELECT e.workspace_id AS k, count(*) AS n FROM executions e JOIN remote_jobs r ON r.execution_id=e.id WHERE e.workspace_id IS NOT NULL GROUP BY e.workspace_id')
  const ofWorkspace: Record<string, unknown> = {}
  for (const w of keys) {
    const before = commands(v32, V32_REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, w.key), after = commands(v33, repo.REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, w.key)
    const candidates: Record<string, unknown> = {}
    for (const [name, sql] of Object.entries(REMOTE_ORDER_CANDIDATES.of_workspace)) {
      candidates[name] = { order_equal_to_v32_on_v32: isDeepStrictEqual(commands(v32, sql, w.key), before), order_equal_to_v32_on_v33: isDeepStrictEqual(commands(v33, sql, w.key), before), plan_v33: planOf(v33, one(sql, [w.key]))[0]!.plan }
    }
    ofWorkspace[`workspace ${qLabel(w.q)}: ${w.count} remote commands`] = {
      plan_v32: planOf(v32, one(V32_REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, [w.key]))[0]!.plan, plan_v33: planOf(v33, one(repo.REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, [w.key]))[0]!.plan,
      same_rows: sameSet(before, after), same_order: isDeepStrictEqual(before, after),
      ms_v32: (await bench(() => v32.all(V32_REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, [w.key]), { n: samples })).ms,
      ms_v33: (await bench(() => v33.all(repo.REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, [w.key]), { n: samples })).ms, candidates,
    }
  }
  out.executions_of_workspace = ofWorkspace
  return out
}

// -- variants: the index sets side by side (synthetic) -------------------------------------------------------------------

/** The v33 step as the product runs it (database.ts MIGRATIONS), statement by statement. */
const V33_STEP: string[] = (() => {
  const step = MIGRATIONS.find(([target]) => target === 33)?.[1]
  if (typeof step !== 'string') throw new Error('the v33 step is expected to be SQL')
  return splitStatements(step)
})()
const COMPOUND_EVENTS = 'CREATE INDEX perf_alt_run_events_by_run_event ON run_events(run_id, event)'
const VARIANTS: Record<string, string[]> = {
  v32: [],
  v33_partial_events: V33_STEP,
  v33_compound_events: [...V33_STEP.filter((s) => !s.includes('run_events_finished_by_run')), COMPOUND_EVENTS],
  v33_keeping_run_only_journal_index: [...V33_STEP, 'CREATE INDEX perf_alt_file_journal_by_run_only ON file_journal(run_id)'],
}
const ALL_INDEX_NAMES = [...V33_INDEXES, 'perf_alt_run_events_by_run_event', 'perf_alt_file_journal_by_run_only']

function perCall(n: number, fn: (i: number) => void): Stats {
  const samples: number[] = []
  for (let i = 0; i < n; i += 1) { const t0 = performance.now(); fn(i); samples.push(performance.now() - t0) }
  return stats(samples)
}

async function sectionVariants(src: string, dir: string, samples: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  let reference: Map<string, unknown> | null = null
  // the keys, chosen once on the v32 copy (a GROUP BY may come out in another order where another index serves it)
  const keyPath = join(dir, 'rp-variant-keys.db')
  clone(src, keyPath)
  const keyConn = openWithoutUpgrade(keyPath)
  const keyed = cases(keyConn, samples).filter((c) => ['runsWithoutFinishEvent', 'listExecutions_by_workspace', 'listJournal_by_run', 'listPreparedJournal_of_run', 'listUnsettledJournal'].includes(c.name))
  const someRun = String(keyConn.get('SELECT id FROM runs LIMIT 1')!.id)
  const sid = String(keyConn.get('SELECT id FROM sessions LIMIT 1')!.id), pid = String(keyConn.get('SELECT project_id FROM sessions WHERE id=?', [sid])!.project_id)
  const ws = String(keyConn.get('SELECT id FROM workspaces LIMIT 1')!.id)
  keyConn.close()
  removeOwned(keyPath)
  for (const [variant, ddl] of Object.entries(VARIANTS)) {
    const path = join(dir, `rp-variant-${variant}.db`)
    clone(src, path)
    const conn = openWithoutUpgrade(path)
    conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const bytesBefore = fileBytes(path)
    quiesce(conn)
    const created: { sql: string; ms: number }[] = []
    conn.transaction(() => { for (const sql of ddl) created.push({ sql, ms: timeOnce(() => conn.exec(sql)).ms }) })
    quiesce(conn)
    conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const row: Record<string, unknown> = { create: created, file_bytes_before: bytesBefore, file_bytes_after: fileBytes(path), index_bytes: indexBytes(conn, ALL_INDEX_NAMES), analyzed: false }
    // the reads, through the product's SQL, at the keys the ab section uses; results against v32's
    const reads: Record<string, unknown> = {}
    const results = new Map<string, unknown>()
    for (const c of keyed) {
      const key = `${c.name}[${c.at}]`
      const m = await measureCell(conn, 'v33', () => c.call(conn), c.n)
      const value = c.call(conn)
      results.set(key, value)
      reads[key] = { ...m, adopted: ALL_INDEX_NAMES.filter((name) => m.plans.some((p) => p.plan.some((line) => line.includes(name)))),
        output_equal_to_v32: reference === null ? null : isDeepStrictEqual(value, reference.get(key)) }
    }
    if (reference === null) reference = results
    row.reads = reads
    // a bound event (the product writes the literal): whether the partial index could serve it
    row.bound_event_plan = planOf(conn, [{ sql: 'SELECT 1 FROM run_events e WHERE e.run_id=? AND e.event=?', params: [someRun, 'run_finished'], kind: 'all' }])[0]!.plan
    // the writes the indexes add to, through the product's writers (rows they need made beforehand, untimed)
    const newRun = () => repo.insertRun(conn, { session_id: sid, project_id: pid, workspace_id: ws, model: 'synthetic:model', model_config: {}, user_text: 'w', status: 'running', budget: {} }).id
    const eventRun = newRun()
    const finishRuns = Array.from({ length: S.writes }, newRun)
    const blob = new Uint8Array(4096).fill(98)
    row.writes = {
      insertEvent_text_delta: perCall(S.writes, (i) => repo.insertEvent(conn, eventRun, i, 'text_delta', { text: 'x'.repeat(200) })),
      insertEvent_run_finished: perCall(S.writes, (i) => repo.insertEvent(conn, finishRuns[i]!, 0, 'run_finished', {})),
      insertExecution_and_finish: perCall(S.writes, () => {
        const x = repo.insertExecution(conn, { run_id: eventRun, workspace_id: ws, tool_call_id: null, kind: 'command', command: 'true', cwd: '/synthetic', isolation: {}, network: false }).id
        repo.finishExecution(conn, x, { status: 'exited', exit_code: 0, timed_out: false, cancelled: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 1, stderr_bytes: 0, duration_ms: 1 })
      }),
      prepare_and_apply_journal_4KiB: perCall(Math.floor(S.writes / 4), (i) => {
        const e = repo.prepareJournalEntry(conn, { workspace_id: ws, session_id: sid, run_id: eventRun, tool_call_id: null, path: `w${i}.txt`, action: 'edited', before: blob, before_sha: 'b', intended_sha: 'a' })
        repo.applyJournalEntry(conn, e.id, blob, 'a')
      }),
    }
    row.integrity_after_writes = String(conn.get('PRAGMA integrity_check')!.integrity_check)
    conn.close()
    removeOwned(path)
    out[variant] = row
  }
  return out
}

// -- upgrade: the first start of this build on a v32 copy, then the steady reopen ------------------------------------------

async function sectionUpgrade(src: string, dir: string, samples: number): Promise<Record<string, unknown>> {
  const repeats = intFromEnv('PERF_INIT_REPEATS', MODE === 'real' ? 1 : 3)
  const runs: Record<string, unknown>[] = []
  for (let i = 0; i < repeats; i += 1) {
    const path = join(dir, `rp-upgrade-${i}.db`)
    clone(src, path)
    assertFree(dir, fileBytes(src) * 2, 'upgrade (a backup of the whole database)')
    const watched = OWNED_SUFFIXES.map((s) => path + s)
    const shared = new SharedArrayBuffer(8 + 8 * 4)
    const stop = new Int32Array(shared, 0, 1)
    const peak = new Float64Array(shared, 8, 4)
    const worker = new Worker(new URL('./read_paths_space_sampler.ts', import.meta.url).href)
    await new Promise<void>((resolve) => { worker.onmessage = () => resolve(); worker.postMessage({ paths: watched, dir, shared, intervalMs: 5 }) })
    const freeBefore = freeBytes(dir)
    const startBytes = watched.reduce((sum, p) => sum + fileBytes(p), 0)
    const opened = timeOnce(() => connect(path))
    Atomics.store(stop, 0, 1)
    Atomics.notify(stop, 0)
    await new Promise<void>((resolve) => { worker.onmessage = () => resolve() })
    worker.terminate()
    const conn = opened.value
    const end = { db_bytes: fileBytes(path), wal_bytes: fileBytes(`${path}-wal`), backup_bytes: fileBytes(`${path}.v32.bak`), partial_left: existsSync(`${path}.v32.bak.partial`) }
    // the step alone, apart from the backup, on another clone of the same copy (an estimate of the split; the whole
    // wall time above is the measurement)
    conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const row: Record<string, unknown> = {
      first_open_ms: opened.ms, user_version_after: Number(conn.get('PRAGMA user_version')!.user_version), start_apparent_bytes: startBytes,
      peak_apparent_bytes: peak[0], peak_over_start_bytes: peak[0]! - startBytes, least_free_drop_bytes: freeBefore - peak[1]!, samples: peak[2],
      end, db_bytes_after_truncate_checkpoint: fileBytes(path), index_bytes: indexBytes(conn, [...V33_INDEXES]),
    }
    if (i === 0) row.steady_reopen_ms = (await bench(() => { connect(path).close() }, { n: Math.min(samples, 10) })).ms
    conn.close()
    removeOwned(path)
    runs.push(row)
  }
  // the split, estimated on one more clone: VACUUM INTO alone, then the v33 step alone (each its own statement)
  const path = join(dir, 'rp-upgrade-split.db')
  clone(src, path)
  const conn = openWithoutUpgrade(path)
  const vacuum = timeOnce(() => conn.db.run('VACUUM INTO ?', [`${path}.v32.bak.partial`])).ms
  rmSync(`${path}.v32.bak.partial`, { force: true })
  quiesce(conn)
  const step: { sql: string; ms: number }[] = []
  conn.transaction(() => { for (const sql of V33_STEP) step.push({ sql, ms: timeOnce(() => conn.exec(sql)).ms }) })
  conn.close()
  removeOwned(path)
  return { source_bytes: fileBytes(src), source_user_version: headerVersion(src), runs, split_estimate: { vacuum_into_ms: vacuum, step } }
}

// -- growth: saveRunProgress with a growing history (synthetic) ---------------------------------------------------------

async function sectionGrowth(dir: string): Promise<Record<string, unknown>> {
  const turns = S.growthTurns
  const estimate = Array.from({ length: turns }, (_, i) => (i + 1) * (S.growthTurnBytes + 400)).reduce((a, b) => a + b, 0) * 2
  if (estimate > genBudgetBytes()) return { skipped: 'over the generated-data budget', estimate_bytes: estimate }
  assertFree(dir, estimate, 'growth')
  const path = join(dir, 'rp-growth.db')
  removeOwned(path)
  const conn = connect(path)
  const pid = repo.createProject(conn, 'synthetic', { source_path: null, base_repo_path: '/synthetic/base.git', base_commit: 'c0', base_branch: 'main', import_report: {} }).id
  const sid = repo.createSession(conn, pid, 's', 'synthetic:model').id
  const newRun = () => repo.insertRun(conn, { session_id: sid, project_id: pid, workspace_id: null, model: 'synthetic:model', model_config: {}, user_text: 'synthetic', status: 'running', budget: {} }).id
  const rid = newRun()
  conn.run('PRAGMA wal_checkpoint(TRUNCATE)')
  const usage = { input_tokens: 1, output_tokens: 1 }
  const turn = (i: number) => JSON.stringify({ role: 'assistant', parts: [{ part_kind: 'tool-call', tool_name: 'bash', tool_call_id: `call_${i}`, args: { command: 'true' } }] })
    + ',' + JSON.stringify({ role: 'tool', parts: [{ part_kind: 'tool-return', tool_call_id: `call_${i}`, content: 'o'.repeat(S.growthTurnBytes) }] })
  let prefix = JSON.stringify({ role: 'user', parts: [{ part_kind: 'text', content: 'synthetic' }] })
  const ms: number[] = [], historyBytes: number[] = [], walBytes: number[] = []
  for (let i = 0; i < turns; i += 1) {
    prefix += ',' + turn(i)
    const history = `[${prefix}]`                                              // built before the timing
    const t0 = performance.now()
    repo.saveRunProgress(conn, rid, history, usage, i + 1)
    ms.push(performance.now() - t0)
    historyBytes.push(Buffer.byteLength(history))
    walBytes.push(fileBytes(`${path}-wal`))
  }
  const deciles = Array.from({ length: 10 }, (_, d) => {
    const from = Math.floor((d * turns) / 10), to = Math.floor(((d + 1) * turns) / 10)
    return { calls: `${from + 1}-${to}`, history_bytes_last: historyBytes[to - 1], ms: stats(ms.slice(from, to)) }
  })
  // statements and plans of one more call, on a run of its own
  const other = newRun()
  const { statements } = recordStatements(conn, () => repo.saveRunProgress(conn, other, `[${prefix}]`, usage, 1))
  const endWal = fileBytes(`${path}-wal`)
  // after the series and labelled as the harness's: one PASSIVE checkpoint, then one more write, then the WAL's size
  quiesce(conn)
  const passive = conn.get('PRAGMA wal_checkpoint(PASSIVE)') as Record<string, number>
  repo.saveRunProgress(conn, other, '[]', usage, 2)
  const out = {
    turns, turn_bytes: S.growthTurnBytes, final_history_bytes: historyBytes[turns - 1], ms: stats(ms), deciles,
    statements: statements.length, plans: planOf(conn, statements),
    wal_without_intervention: { peak_bytes: Math.max(...walBytes), end_bytes: endWal, after_call: walBytes.filter((_, i) => i % Math.max(1, Math.floor(turns / 20)) === 0) },
    harness_intervention_after_series: { note: 'one PASSIVE checkpoint by this script, then one more write; not the app\'s own automatic checkpointing', passive_busy: Number(passive.busy), passive_log_frames: Number(passive.log), passive_checkpointed_frames: Number(passive.checkpointed), wal_bytes_after_one_more_write: fileBytes(`${path}-wal`) },
    db_bytes: fileBytes(path),
  }
  conn.close()
  removeOwned(path)
  return out
}

// -- main ------------------------------------------------------------------------------------------------------------------

main(async () => {
  const samples = intFromEnv('PERF_SAMPLES', 15)
  const result: Record<string, unknown> = { kind: 'read_paths', mode: MODE, scale: MODE === 'synthetic' ? SCALE : null, schema_version_code: SCHEMA_VERSION, sections: [...SECTIONS], fingerprint: fingerprint() }
  let src: string, dir: string
  if (MODE === 'real') {
    dir = dirFromEnv('PERF_PRIVATE')
    src = join(dir, 'index.db')
    if (!existsSync(src) || fileBytes(`${src}-wal`) > 0) throw new Error('PERF_PRIVATE must hold a closed index.db copy')
    if (headerVersion(src) !== 32) throw new Error('the copy is not at schema v32')
    result.copy_bytes = fileBytes(src)
  } else {
    dir = dirFromEnv('PERF_SCRATCH')
    src = join(dir, 'rp-base-v32.db')
    const estimate = S.journalEntries * S.journalBlob * 2 + 512 * 1024 * 1024
    if (estimate > genBudgetBytes()) throw Object.assign(new Error('the synthetic database is over the generated-data budget'), { code: 'PERF_GEN_BUDGET' })
    assertFree(dir, estimate * 4, 'synthetic read paths (the base and its working clones)')
    const built = timeOnce(() => buildSyntheticV32(src))
    result.synthetic = { build_ms: built.ms, ...built.value, sizes: S }
  }
  try {
    if (SECTIONS.has('ab')) result.ab = await sectionAb(src, dir, samples)
    if (SECTIONS.has('variants')) result.variants = await sectionVariants(src, dir, samples)
    if (SECTIONS.has('upgrade')) result.upgrade = await sectionUpgrade(src, dir, samples)
    if (SECTIONS.has('growth')) result.growth = await sectionGrowth(dir)
  } finally {
    if (MODE === 'synthetic') removeOwned(src)
  }
  if (MODE === 'real') result.console_lines_silenced = (globalThis as Record<string, unknown>).__perfSilenced
  writeResult(`read_paths_${MODE}${MODE === 'synthetic' ? `_${SCALE}` : ''}`, result)
})
