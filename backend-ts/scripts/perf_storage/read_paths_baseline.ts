/** The schema v33 read paths, set beside what they replace, for the regression test (tests/test_sqlite_read_paths.test.ts)
 *  and the benchmark (read_paths_bench.ts). Two switches, each on its own, so the same production function is called
 *  in all four cells:
 *
 *    SQL     `baselineSql` turns each statement v33 changed back into the statement of v32 — the run and journal rows
 *            read whole (`SELECT *`), the two remote reads without their ORDER BY — and leaves every other statement
 *            as it is; `withSql` runs a function with a connection's statements so rewritten.
 *    schema  `rewindToV32` takes a v33 database's indexes back to v32's (the only difference between the two); a
 *            database opened with `openWithoutUpgrade` stays as it is.
 *
 *  baseline = v32 schema + v32 SQL; projection only = v32 schema + v33 SQL; index only = v33 schema + v32 SQL;
 *  combined = v33 schema + v33 SQL (the product). Nothing here is used by the product. */

import { Database } from 'bun:sqlite'
import { Conn, type Param, type Row } from '../../src/db/database.ts'
import { JOURNAL_COLUMNS, REMOTE_EXECUTION_WORKSPACES_SQL, REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, RUN_COLUMNS, RUN_COLUMNS_R } from '../../src/db/repo.ts'

/** The two remote reads as v32 had them, inline (src/main.ts and src/execution/processes.ts at a4dc9ca), with no
 *  ORDER BY; v33 names them in repo.ts with the order v32's plan gave them stated. */
export const V32_REMOTE_EXECUTION_WORKSPACES_SQL = 'SELECT DISTINCT e.workspace_id FROM executions e JOIN remote_jobs r ON r.execution_id=e.id'
export const V32_REMOTE_EXECUTIONS_OF_WORKSPACE_SQL = 'SELECT r.execution_id FROM remote_jobs r JOIN executions e ON e.id=r.execution_id WHERE e.workspace_id=?'

/** The orders the remote reads were tried with (measured: v32's plan scans executions in rowid order, v33's index
 *  would reorder both; by_execution_rowid is the one that returns v32's order and is the product's). */
export const REMOTE_ORDER_CANDIDATES = {
  workspaces: {
    by_remote_job_rowid: 'SELECT e.workspace_id FROM executions e JOIN remote_jobs r ON r.execution_id=e.id GROUP BY e.workspace_id ORDER BY min(r.rowid)',
    by_execution_rowid: 'SELECT e.workspace_id FROM executions e JOIN remote_jobs r ON r.execution_id=e.id GROUP BY e.workspace_id ORDER BY min(e.rowid)',
    by_remote_job_key: 'SELECT e.workspace_id FROM executions e JOIN remote_jobs r ON r.execution_id=e.id GROUP BY e.workspace_id ORDER BY min(r.execution_id)',
  },
  of_workspace: {
    by_remote_job_rowid: 'SELECT r.execution_id FROM remote_jobs r JOIN executions e ON e.id=r.execution_id WHERE e.workspace_id=? ORDER BY r.rowid',
    by_execution_rowid: 'SELECT r.execution_id FROM remote_jobs r JOIN executions e ON e.id=r.execution_id WHERE e.workspace_id=? ORDER BY e.rowid',
    by_remote_job_key: 'SELECT r.execution_id FROM remote_jobs r JOIN executions e ON e.id=r.execution_id WHERE e.workspace_id=? ORDER BY r.execution_id',
  },
} as const

const HEADS: [string, string][] = [
  [`SELECT ${RUN_COLUMNS} FROM runs `, 'SELECT * FROM runs '],
  [`SELECT ${RUN_COLUMNS_R} FROM runs r `, 'SELECT r.* FROM runs r '],
  [`SELECT ${JOURNAL_COLUMNS} FROM file_journal `, 'SELECT * FROM file_journal '],
]

/** The statement v32 ran where v33 runs `sql` (the same text when v33 did not change it). */
export function baselineSql(sql: string): string {
  if (sql === REMOTE_EXECUTION_WORKSPACES_SQL) return V32_REMOTE_EXECUTION_WORKSPACES_SQL
  if (sql === REMOTE_EXECUTIONS_OF_WORKSPACE_SQL) return V32_REMOTE_EXECUTIONS_OF_WORKSPACE_SQL
  for (const [now, before] of HEADS) if (sql.startsWith(now)) return before + sql.slice(now.length)
  return sql
}

export type SqlMode = 'v32' | 'v33'

/** `fn` with the connection's statements as `mode` has them ('v33': unchanged). A recorder already on the connection
 *  (scripts/perf_storage/common.ts recordStatements) stays under the rewrite, sees the statement that runs, and is put
 *  back after; install the recorder first, then this. */
export function withSql<T>(conn: Conn, mode: SqlMode, fn: () => T): T {
  if (mode === 'v33') return fn()
  const ownAll = Object.getOwnPropertyDescriptor(conn, 'all'), ownGet = Object.getOwnPropertyDescriptor(conn, 'get')
  const all = conn.all.bind(conn), get = conn.get.bind(conn)
  conn.all = (sql: string, params: Param[] = []): Row[] => all(baselineSql(sql), params)
  conn.get = (sql: string, params: Param[] = []): Row | null => get(baselineSql(sql), params)
  try { return fn() } finally {
    if (ownAll) Object.defineProperty(conn, 'all', ownAll); else delete (conn as Partial<Conn>).all
    if (ownGet) Object.defineProperty(conn, 'get', ownGet); else delete (conn as Partial<Conn>).get
  }
}

/** v33's indexes taken back to v32's, and the version with them: what a v32 build left. */
export const REWIND_TO_V32_SQL = `
DROP INDEX run_events_finished_by_run;
DROP INDEX executions_by_workspace;
DROP INDEX file_journal_by_run;
CREATE INDEX file_journal_by_run ON file_journal(run_id);
PRAGMA user_version = 32;
`

export function rewindToV32(conn: Conn): void {
  conn.exec(REWIND_TO_V32_SQL)
}

/** A database opened as connect() opens it (the same PRAGMAs) but left at the version it is: no migration, no backup. */
export function openWithoutUpgrade(path: string): Conn {
  const conn = new Conn(new Database(path), path)
  conn.exec('PRAGMA busy_timeout=5000')
  conn.exec('PRAGMA journal_mode=WAL')
  conn.exec('PRAGMA foreign_keys=ON')
  return conn
}

/** The indexes v33 adds or redefines, by table: names and their SQL as SQLite keeps it. */
export const V33_INDEXES = ['run_events_finished_by_run', 'executions_by_workspace', 'file_journal_by_run'] as const
