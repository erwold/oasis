/** Schema lifecycle (adapted from oasis tests/test_migrations.py, see NOTICE): a fresh database comes from
 *  schema.sql, an older one is brought forward by MIGRATIONS, and both paths must land on the same structure. */

import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '@oasis-code/contract'
import { connect, repairKnownColumns, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { tempDir } from './helpers.ts'

const FIXTURES = join(import.meta.dir, 'fixtures')

function structure(conn: Conn): Record<string, unknown> {
  const tables = conn.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name as string).sort()
  const out: Record<string, unknown> = {}
  for (const t of tables) {
    out[t] = {
      columns: conn.all(`PRAGMA table_info(${t})`).map((r) => [r.name, r.type, r.notnull, r.dflt_value, r.pk]),
      indexes: conn.all(`PRAGMA index_list(${t})`).map((r) => r.name as string).filter((n) => !n.startsWith('sqlite_')).sort(),
    }
  }
  return out
}

for (const [version, fixture] of [[1, 'schema_v1.sql'], [2, 'schema_v2.sql']] as const) {
  test(`a v${version} database migrated equals a fresh one`, () => {
    const base = tempDir()
    mkdirSync(join(base, 'old'))
    const old = join(base, 'old', 'index.db')
    const raw = new Database(old)
    raw.exec(readFileSync(join(FIXTURES, fixture), 'utf8') + `\nPRAGMA user_version = ${version};`)
    raw.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','legacy','/x','t','t')")
    raw.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at) VALUES ('s_1','p_1','t','m','t','t')")
    raw.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at) VALUES ('run_1','s_1','p_1','m','hi','done','t')")
    raw.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at) VALUES ('run_2','s_1','p_1','m','wait','waiting','t')")
    raw.close()

    const migrated = connect(old)
    const fresh = connect(join(base, 'fresh', 'index.db'))
    try {
      expect(migrated.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
      expect(SCHEMA_VERSION).toBe(37)                                              // v7 attachments, v8 run keys, v9 project / session keys, v10 the director session, v11 the network granted, v12 no run tree, v13 the relay, v14 the relay's fresh / resumes_run_id, v15 the interaction, v16 its notes, v17 who named a session, v18 the watches, v19 the journal of a folder edited in place, v20 what a journalled write meant to leave, v21 the UI surfaces and their action receipts, v22 the UI tasks and input requests, v23 the session-scoped surfaces and the publication journal, v24 the director envelope and source mounts, v25 the collaboration model (participants, conversations, edges, run_collab), v26 the session cursor (run_events.cursor, event_cursor), v27 the sessions' latest activity, v28 the sessions' access and the access caps, v29 the sessions' task and roots, v30 the SSH targets and remote records, v31 the SSH targets' connect intent, v32 currency-separated CNY model costs, v33 the read-path indexes, v34 the live share links, v35 the live links' protocol and task, v36 the pinned sessions, v37 the run read index
      expect(structure(migrated)).toEqual(structure(fresh))
      expect('relays' in structure(migrated)).toBe(true)
      for (const column of ['relay_id', 'relay_step']) expect((structure(migrated) as Record<string, { columns: unknown[][] }>).runs!.columns.some((c) => c[0] === column), column).toBe(true)
      for (const column of ['fresh', 'resumes_run_id']) expect((structure(migrated) as Record<string, { columns: unknown[][] }>).relays!.columns.some((c) => c[0] === column), column).toBe(true)
      expect('director_notes' in structure(migrated)).toBe(true)
      expect((structure(migrated) as Record<string, { columns: unknown[][] }>).director_notes!.columns.some((c) => c[0] === 'turn_id')).toBe(true)
      for (const t of ['director_sessions', 'director_turns', 'director_outbox', 'interactions', 'interaction_nodes', 'interaction_events', 'interaction_notes']) expect(t in structure(migrated), t).toBe(true)
      for (const column of ['interaction_id', 'interaction_node']) expect((structure(migrated) as Record<string, { columns: unknown[][] }>).runs!.columns.some((c) => c[0] === column), column).toBe(true)
      expect((structure(migrated) as Record<string, { columns: unknown[][] }>).projects!.columns.some((c) => c[0] === 'kind')).toBe(true)
      for (const t of ['ui_surfaces', 'ui_action_receipts', 'ui_tasks', 'ui_inputs']) expect(t in structure(migrated), t).toBe(true)
      for (const t of ['relation_grants', 'messages', 'claims', 'evidence', 'interventions', 'task_board']) expect(t in structure(migrated), t).toBe(false)
      expect((structure(migrated) as Record<string, { columns: unknown[][] }>).interactions!.columns.some((c) => c[0] === 'then_action')).toBe(true)   // v15's interactions, not v5's (dropped in v12)
      const row = migrated.get("SELECT * FROM runs WHERE id='run_1'")!
      expect(row.work_order_json).toBeNull()
      expect('can_dispatch' in row).toBe(false)
      expect('director_prompt' in row).toBe(false)
      expect(row.attachments_json).toBe('[]')                                      // an old run has no attachments
      expect(row.client_request_id).toBeNull()                                     // nor a client key
      expect(migrated.get("SELECT client_request_id FROM sessions WHERE id='s_1'")!.client_request_id).toBeNull()
      expect(migrated.get("SELECT client_request_id FROM projects WHERE id='p_1'")!.client_request_id).toBeNull()
      const run = repo.getRun(migrated, 'run_1')!
      expect(run.work_order).toBeNull()
      expect(run.relay_id).toBeNull()                                                // an old run is a turn of no relay
      expect(run.interaction_id).toBeNull()                                          // nor a node of an interaction
      expect(repo.listInteractions(migrated, 's_1')).toEqual([])
      expect(repo.listRelays(migrated, 's_1')).toEqual([])
      expect(run.attachments).toEqual([])
      const left = repo.getRun(migrated, 'run_2')!                                 // a run an older build left waiting on its children
      expect(left.status).toBe('error')
      expect(left.error).toContain('child runs')
      expect(repo.listThreadRuns(migrated, 's_1').map((r) => r.id)).toEqual(['run_1', 'run_2'])
    } finally {
      migrated.close()
      fresh.close()
    }
  })
}

/** runs as v13 had it: rebuilt from its own CREATE statement without v15's interaction columns. They are not dropped
 *  with DROP COLUMN because SQLite 3.51.0 (Bun 1.4.2) rewrites the table wrongly ("incomplete input") when the dropped
 *  last column follows a `--` comment line, as interaction_node does in schema.sql; no migration drops them. */
function rewindRunsToV13(conn: Conn): void {
  const create = String(conn.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'")!.sql)
  const v13 = create.replace(/,\s*-- the interaction this run is a node of[^\n]*\n\s*interaction_id\s+TEXT,\s*interaction_node\s+TEXT\s*\)$/, '\n)')
  expect(v13).not.toBe(create)
  const indexes = conn.all("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='runs' AND sql IS NOT NULL AND name NOT IN ('runs_by_interaction', 'runs_read')")
    .map((r) => String(r.sql))
  conn.exec('PRAGMA foreign_keys=OFF')
  conn.exec(v13.replace(/^CREATE TABLE runs\b/, 'CREATE TABLE runs_v13'))
  const columns = conn.all('PRAGMA table_info(runs_v13)').map((r) => String(r.name)).join(', ')
  conn.exec(`INSERT INTO runs_v13 (${columns}) SELECT ${columns} FROM runs`)
  conn.exec('DROP TABLE runs')
  conn.exec('ALTER TABLE runs_v13 RENAME TO runs')
  for (const sql of indexes) conn.exec(sql)
  conn.exec('PRAGMA foreign_keys=ON')
}

/** Two v13 databases exist in the wild: the first build's relays table without fresh / resumes_run_id, and a later v13
 *  that already carried them. Both come forward to v14 and equal a fresh database; a relay starts on either. */
for (const variant of ['without the columns', 'with the columns'] as const) {
  test(`a v13 database ${variant} upgrades to the current schema and equals a fresh one`, async () => {
    const base = tempDir()
    const path = join(base, 'old', 'index.db')
    const made = connect(path)                                                       // a fresh database …
    made.exec('DROP TABLE interaction_notes')
    made.exec('DROP TABLE interaction_events')
    made.exec('DROP TABLE interaction_nodes')
    made.exec('DROP TABLE interactions')
    rewindRunsToV13(made)
    if (variant === 'without the columns') {
      made.exec('ALTER TABLE relays DROP COLUMN fresh')
      made.exec('ALTER TABLE relays DROP COLUMN resumes_run_id')
    }
    made.exec('DROP INDEX IF EXISTS runs_read; PRAGMA user_version = 13')                                            // … rewound to the v13 shape
    made.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','legacy','/x','t','t')")
    made.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at) VALUES ('s_1','p_1','t','m','t','t')")
    made.run("INSERT INTO relays (id, session_id, status, user_text, participants_json, steps_json, rounds, round, current_step, created_at, updated_at) VALUES ('relay_1','s_1','done','hi','[]','[]',1,1,0,'t','t')")
    made.close()
    const migrated = connect(path)
    const fresh = connect(join(base, 'fresh', 'index.db'))
    try {
      expect(migrated.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
      expect(structure(migrated)).toEqual(structure(fresh))
      const relay = migrated.get("SELECT fresh, resumes_run_id FROM relays WHERE id='relay_1'")!
      expect([relay.fresh, relay.resumes_run_id]).toEqual([0, null])
      expect(repo.relayInputs(migrated, 'relay_1').fresh).toBe(false)
      // opened once more: nothing left to do, the same structure
      migrated.close()
      const again = connect(path)
      expect(again.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
      expect(structure(again)).toEqual(structure(fresh))
      again.close()
    } finally { fresh.close() }
  })
}

test('a database that says v16 but lacks the relay columns (a copy rewound by hand) is repaired on open, and left alone once whole', () => {
  const base = tempDir()
  const path = join(base, 'odd', 'index.db')
  const made = connect(path)
  made.exec('ALTER TABLE relays DROP COLUMN fresh')
  made.exec('ALTER TABLE relays DROP COLUMN resumes_run_id')
  expect(made.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
  made.close()
  const repaired = connect(path)
  const fresh = connect(join(base, 'fresh', 'index.db'))
  try {
    expect(structure(repaired)).toEqual(structure(fresh))
    expect(repairKnownColumns(repaired)).toEqual([])                                   // whole: nothing to add
  } finally { repaired.close(); fresh.close() }
})
