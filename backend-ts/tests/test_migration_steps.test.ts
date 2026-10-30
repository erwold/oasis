/** A migration step happens whole or not at all: a failing statement anywhere in a step rolls it back, the version on
 *  disk stays where it was and the open fails saying so. Also the databases whose history is not main's (the
 *  director-session branch's v8), unreadable stored grants, a database another process holds, and the copy an upgrade
 *  keeps of the database as it was. */

import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SCHEMA_VERSION } from '@oasis-code/contract'
import { connect, splitStatements, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { tempDir } from './helpers.ts'

const FIXTURES = join(import.meta.dir, 'fixtures')

function structure(conn: Conn): Record<string, unknown> {
  const tables = conn.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name as string).sort()
  const out: Record<string, unknown> = {}
  for (const t of tables) {
    out[t] = {
      columns: conn.all(`PRAGMA table_info(${t})`).map((r) => [r.name, r.type, r.notnull, r.dflt_value, r.pk]).sort(),
      indexes: conn.all(`PRAGMA index_list(${t})`).map((r) => r.name as string).filter((n) => !n.startsWith('sqlite_')).sort(),
    }
  }
  return out
}

/** A database of an older schema: the fixture's script, the given version, and one project, session and two runs. */
function oldDatabase(fixture: string, version: number, extra = ''): string {
  const dir = join(tempDir(), 'old')
  mkdirSync(dir)
  const path = join(dir, 'index.db')
  const raw = new Database(path)
  raw.exec(readFileSync(join(FIXTURES, fixture), 'utf8'))
  raw.run(`PRAGMA user_version = ${version}`)
  raw.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','legacy','/x','t','t')")
  raw.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at) VALUES ('s_1','p_1','t','m','t','t')")
  raw.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at) VALUES ('run_1','s_1','p_1','m','hi','done','t')")
  raw.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at) VALUES ('run_2','s_1','p_1','m','wait','waiting','t')")
  for (const statement of splitStatements(extra)) raw.run(statement)
  raw.close()
  return path
}

function onDisk(path: string): { version: number; runColumns: string[] } {
  const raw = new Database(path)
  try {
    return {
      version: Number((raw.query('PRAGMA user_version').get() as { user_version: number }).user_version),
      runColumns: (raw.query('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name),
    }
  } finally { raw.close() }
}

test('a script splits at the semicolons that end statements, not those in quotes or comments', () => {
  expect(splitStatements(`
-- the person's words; not code
CREATE TABLE a (x TEXT DEFAULT 'a;b', "odd;name" TEXT, [br;acket] TEXT);  /* a; comment */
INSERT INTO a (x) VALUES ('it''s; here');
-- trailing comment only
`)).toEqual([
    `-- the person's words; not code\nCREATE TABLE a (x TEXT DEFAULT 'a;b', "odd;name" TEXT, [br;acket] TEXT)`,
    `/* a; comment */\nINSERT INTO a (x) VALUES ('it''s; here')`,
  ])
  expect(splitStatements('SELECT 1')).toEqual(['SELECT 1'])
  expect(splitStatements('  -- nothing\n ; ;')).toEqual([])
})

test("a script's failing statement that is not its last raises, and the statements after it do not run", () => {
  const conn = connect(join(tempDir(), 'db', 'index.db'))
  try {
    expect(() => conn.exec("CREATE TABLE t1 (x UNIQUE); INSERT INTO t1 VALUES (1); INSERT INTO t1 VALUES (1); CREATE TABLE t2 (x)"))
      .toThrow(/UNIQUE constraint failed/)
    expect(conn.get("SELECT name FROM sqlite_master WHERE name='t2'")).toBeNull()
  } finally { conn.close() }
})

test('a step whose statement fails part-way is rolled back whole: the version stays at the step before and the open says so', () => {
  // an index on director_prompt makes v12's DROP COLUMN fail after v12 already ended the waiting run and dropped tables
  const path = oldDatabase('schema_v2.sql', 2, 'CREATE INDEX blocks_the_drop ON runs(director_prompt)')
  expect(() => connect(path)).toThrow(/upgrade to schema v12 failed and was rolled back \(the database stays at v11\).*director_prompt/)
  const after = onDisk(path)
  expect(after.version).toBe(11)
  expect(after.runColumns).toContain('director_prompt')
  const raw = new Database(path)
  try {
    expect((raw.query("SELECT status FROM runs WHERE id='run_2'").get() as { status: string }).status).toBe('waiting')
    expect(raw.query("SELECT name FROM sqlite_master WHERE name='task_board'").get()).not.toBeNull()
    raw.run('DROP INDEX blocks_the_drop')
  } finally { raw.close() }
  const retried = connect(path)                                                     // once the cause is gone the upgrade completes
  try {
    expect(retried.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
    expect(repo.getRun(retried, 'run_2')!.status).toBe('error')
  } finally { retried.close() }
})

test('a v8 database of the director-session branch, which already has v10\'s tables, upgrades and equals a fresh one', () => {
  const path = oldDatabase('schema_v8_director_branch.sql', 8,
    "INSERT INTO director_notes (id, session_id, source, answer, created_at, turn_id) VALUES ('dn_1','s_1','chatgpt','kept','t','turn_1')")
  const migrated = connect(path)
  const fresh = connect(join(tempDir(), 'fresh', 'index.db'))
  try {
    expect(migrated.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
    expect(structure(migrated)).toEqual(structure(fresh))                             // main's v8 run key included
    expect(migrated.get("SELECT answer, turn_id FROM director_notes WHERE id='dn_1'")).toEqual({ answer: 'kept', turn_id: 'turn_1' })
    expect(repo.getRun(migrated, 'run_1')!.status).toBe('done')
  } finally { migrated.close(); fresh.close() }
})

test('v11 grants the network to every session whose grants are readable, and keeps unreadable grants as stored', () => {
  const path = oldDatabase('schema_v2.sql', 2, `
UPDATE sessions SET grants_json = '{"workspace_write":true,"network":false}' WHERE id = 's_1';
INSERT INTO sessions (id, project_id, title, model, grants_json, created_at, updated_at) VALUES ('s_bad','p_1','t','m','{not json','t','t');
INSERT INTO sessions (id, project_id, title, model, grants_json, created_at, updated_at) VALUES ('s_list','p_1','t','m','[1,2]','t','t');
`)
  const conn = connect(path)
  try {
    expect(conn.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
    expect(JSON.parse(String(conn.get("SELECT grants_json FROM sessions WHERE id='s_1'")!.grants_json)))
      .toEqual({ workspace_write: true, network: true, network_until: null })
    expect(conn.get("SELECT grants_json FROM sessions WHERE id='s_bad'")!.grants_json).toBe('{not json')
    expect(conn.get("SELECT grants_json FROM sessions WHERE id='s_list'")!.grants_json).toBe('[1,2]')
    expect(repo.getSession(conn, 's_bad')!.grants.network).toBe(true)                 // read as the default grants
  } finally { conn.close() }
})

test('a database another process holds for writing is not upgraded, the open says why, and a later open completes', () => {
  const path = join(tempDir(), 'held', 'index.db')
  const made = connect(path)
  made.exec('DROP TABLE file_journal')
  made.exec('PRAGMA user_version = 18')
  made.close()
  const holder = new Database(path)
  holder.run('BEGIN IMMEDIATE')
  try {
    expect(() => connect(path)).toThrow(/upgrade to schema v19 failed and was rolled back \(the database stays at v18\): another process holds the database's write lock/)
  } finally {
    holder.run('ROLLBACK')
    holder.close()
  }
  expect(onDisk(path).version).toBe(18)
  const again = connect(path)
  try {
    expect(again.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
    expect(again.get("SELECT name FROM sqlite_master WHERE name='file_journal'")).not.toBeNull()
  } finally { again.close() }
}, 30_000)

test('test_upgrade_backup: an upgrade first copies the database as it was beside it, keeps only the latest copy, and a fresh or current one is not copied', () => {
  const path = oldDatabase('schema_v2.sql', 2)
  const dir = dirname(path)
  writeFileSync(join(dir, 'index.db.v1.bak'), 'an older upgrade\'s copy')
  writeFileSync(join(dir, 'other.db.v1.bak'), 'not this database\'s')
  const conn = connect(path)
  conn.close()
  const backup = join(dir, 'index.db.v2.bak')
  // the copy is the database as it was: its version, its rows, readable by itself
  expect(onDisk(backup).version).toBe(2)
  const raw = new Database(backup, { readonly: true })
  try { expect((raw.query("SELECT count(*) AS n FROM runs").get() as { n: number }).n).toBe(2) } finally { raw.close() }
  expect(existsSync(join(dir, 'index.db.v1.bak'))).toBe(false)
  expect(existsSync(join(dir, 'other.db.v1.bak'))).toBe(true)
  expect(readdirSync(dir).filter((f) => f.endsWith('.partial'))).toEqual([])
  // opening the upgraded database again copies nothing more
  connect(path).close()
  expect(readdirSync(dir).filter((f) => f.startsWith('index.db.v')).sort()).toEqual(['index.db.v2.bak'])
  // a new database is not copied
  const fresh = join(tempDir(), 'fresh', 'index.db')
  connect(fresh).close()
  expect(readdirSync(dirname(fresh)).filter((f) => f.endsWith('.bak'))).toEqual([])
})

test('test_upgrade_backup: a database that cannot be copied is not upgraded, and the open says why', () => {
  const path = oldDatabase('schema_v2.sql', 2)
  const dir = dirname(path)
  // the copy's place taken by a folder: the copy cannot land, so nothing is upgraded
  mkdirSync(join(dir, 'index.db.v2.bak'))
  writeFileSync(join(dir, 'index.db.v2.bak', 'keep'), 'x')
  chmodSync(join(dir, 'index.db.v2.bak'), 0o500)
  try {
    expect(() => connect(path)).toThrow(/could not be copied before its upgrade to v\d+, so it was not upgraded/)
  } finally { chmodSync(join(dir, 'index.db.v2.bak'), 0o700) }
  expect(onDisk(path).version).toBe(2)
  expect(readdirSync(dir).filter((f) => f.endsWith('.partial'))).toEqual([])
})
