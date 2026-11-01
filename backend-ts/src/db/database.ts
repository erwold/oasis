/** SQLite connection and schema lifecycle. schema.sql is the baseline for a new database; MIGRATIONS bring an
 *  older one forward by PRAGMA user_version (a v0 database migrated all the way must equal a fresh one; a test pins
 *  that). One connection per process; bun:sqlite is synchronous, so a statement's rows are always complete before
 *  the next one runs — the interleaving the first backend had to lock against cannot happen here.
 *
 *  An upgrade cannot be undone by an older build (it refuses a newer schema), so before the first step of one the
 *  database is copied whole beside itself (`index.db.v<N>.bak`, a consistent copy made by SQLite; the last one kept). */

import { Database } from 'bun:sqlite'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCHEMA_VERSION } from '@oasis-code/contract'
import { backfillSessionActivity } from './repo.ts'
import { RUN_READ_INDEX_SQL } from './run_read_index.ts'

export { SCHEMA_VERSION }
export const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')
// the schema travels with the code (a compiled binary has no file beside it)
import SCHEMA_SQL from './schema.sql' with { type: 'text' }
import REMOTE_SCHEMA_SQL from './remote_schema.sql' with { type: 'text' }

/** A migration is SQL, or a function for a step SQL cannot say (a column added only when absent). */
export type Migration = string | ((conn: Conn) => void)

/** Add a column unless the table has it (SQLite has no ADD COLUMN IF NOT EXISTS). */
export function addColumnIfMissing(conn: Conn, table: string, column: string, definition: string): boolean {
  const present = conn.all(`PRAGMA table_info(${table})`).some((r) => r.name === column)
  if (present) return false
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

// CASE, not AND: json_type() raises on text that is not JSON, and SQLite does not promise to short-circuit AND
const GRANTS_READABLE = "CASE WHEN json_valid(grants_json) THEN json_type(grants_json) = 'object' ELSE 0 END"

// One complete statement: keep the trigger body out of splitStatements. Also installed for a fresh database.
const SESSION_PIN_CLEANUP = `CREATE TRIGGER IF NOT EXISTS sessions_clear_pin AFTER UPDATE OF status ON sessions
WHEN NEW.status <> 'open' AND NEW.pin_order IS NOT NULL
BEGIN
  UPDATE sessions SET pin_order=NULL WHERE id=NEW.id;
END`

export const MIGRATIONS: [number, Migration][] = [
  [2, `
ALTER TABLE runs ADD COLUMN work_order_json TEXT;
ALTER TABLE runs ADD COLUMN can_dispatch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN director_prompt TEXT;
CREATE INDEX runs_by_parent ON runs(parent_run_id);
`],
  [3, `
CREATE TABLE governance_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  kind        TEXT NOT NULL,
  run_id      TEXT,
  ref         TEXT,
  actor       TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX governance_by_session ON governance_log(session_id, kind, id);
CREATE INDEX governance_by_ref ON governance_log(ref);
`],
  [4, `
CREATE TABLE director_notes (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  source     TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  question   TEXT NOT NULL DEFAULT '',
  answer     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX director_notes_by_session ON director_notes(session_id, created_at);
`],
  [5, `
CREATE TABLE interactions (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  project_id        TEXT NOT NULL REFERENCES projects(id),
  kind              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  label             TEXT,
  owner_run_id      TEXT,
  participants_json TEXT NOT NULL DEFAULT '{}',
  phase             TEXT NOT NULL DEFAULT '',
  config_json       TEXT NOT NULL DEFAULT '{}',
  result_json       TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  finished_at       TEXT
);
CREATE INDEX interactions_by_session ON interactions(session_id, created_at);
CREATE INDEX interactions_by_status ON interactions(status);

CREATE TABLE relation_grants (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  subject_run_id TEXT NOT NULL,
  object_run_id  TEXT,
  rights_json    TEXT NOT NULL DEFAULT '[]',
  granted_by     TEXT NOT NULL,
  interaction_id TEXT,
  created_at     TEXT NOT NULL,
  revoked_at     TEXT
);
CREATE INDEX relation_grants_by_subject ON relation_grants(subject_run_id);
CREATE INDEX relation_grants_by_session ON relation_grants(session_id);

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  interaction_id      TEXT,
  from_actor          TEXT NOT NULL,
  from_run_id         TEXT,
  to_run_id           TEXT NOT NULL,
  kind                TEXT NOT NULL,
  body                TEXT NOT NULL,
  refs_json           TEXT NOT NULL DEFAULT '{}',
  reply_to            TEXT,
  dedupe_key          TEXT,
  created_at          TEXT NOT NULL,
  delivered_at        TEXT,
  delivered_to_run_id TEXT,
  expires_at          TEXT,
  useful              INTEGER
);
CREATE INDEX messages_by_recipient ON messages(to_run_id, created_at);
CREATE INDEX messages_by_session ON messages(session_id, created_at);
CREATE UNIQUE INDEX messages_dedupe ON messages(to_run_id, dedupe_key);

CREATE TABLE claims (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  run_id         TEXT NOT NULL,
  interaction_id TEXT,
  checkpoint_id  TEXT,
  text           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX claims_by_session ON claims(session_id, created_at);
CREATE INDEX claims_by_run ON claims(run_id);

CREATE TABLE evidence (
  id         TEXT PRIMARY KEY,
  claim_id   TEXT NOT NULL REFERENCES claims(id),
  run_id     TEXT,
  kind       TEXT NOT NULL,
  verdict    TEXT NOT NULL,
  refs_json  TEXT NOT NULL DEFAULT '{}',
  note       TEXT NOT NULL DEFAULT '',
  verified   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX evidence_by_claim ON evidence(claim_id, created_at);

CREATE TABLE interventions (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  interaction_id TEXT,
  requested_by   TEXT NOT NULL,
  target_run_id  TEXT NOT NULL,
  kind           TEXT NOT NULL,
  reason         TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'pending',
  decided_by     TEXT,
  decided_at     TEXT,
  result_json    TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);
CREATE INDEX interventions_by_session ON interventions(session_id, status);
CREATE INDEX interventions_by_target ON interventions(target_run_id);

CREATE TABLE task_board (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  project_id        TEXT NOT NULL REFERENCES projects(id),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  serves            TEXT NOT NULL DEFAULT '',
  evidence_refs_json TEXT NOT NULL DEFAULT '{}',
  proposed_by       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  claimed_by_run_id TEXT,
  lease_until       TEXT,
  dispatched_run_id TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX task_board_by_session ON task_board(session_id, status);
`],
  [6, `
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'snapshot';
`],
  [7, `
ALTER TABLE runs ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
`],
  [8, `
ALTER TABLE runs ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX runs_by_client_request ON runs(session_id, client_request_id) WHERE client_request_id IS NOT NULL;
`],
  [9, `
ALTER TABLE projects ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX projects_by_client_request ON projects(client_request_id) WHERE client_request_id IS NOT NULL;
ALTER TABLE sessions ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX sessions_by_client_request ON sessions(project_id, client_request_id) WHERE client_request_id IS NOT NULL;
`],
  // v10: the director session. The director-session branch (1fe5d21) stored these tables and turn_id at its own v8,
  // without main's v8 run key: such a database keeps what it has and gains the key.
  [10, (conn) => {
    addColumnIfMissing(conn, 'director_notes', 'turn_id', 'TEXT')
    addColumnIfMissing(conn, 'runs', 'client_request_id', 'TEXT')
    conn.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS runs_by_client_request ON runs(session_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS director_sessions (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  transport       TEXT NOT NULL,
  model           TEXT NOT NULL DEFAULT '',
  label           TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'idle',
  config_json     TEXT NOT NULL DEFAULT '{}',
  external_ref    TEXT,
  current_turn_id TEXT,
  last_error      TEXT,
  history_json    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS director_sessions_by_session ON director_sessions(session_id, created_at);

CREATE TABLE IF NOT EXISTS director_turns (
  id                  TEXT PRIMARY KEY,
  director_session_id TEXT NOT NULL REFERENCES director_sessions(id),
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  seq                 INTEGER NOT NULL,
  kind                TEXT NOT NULL,
  input               TEXT NOT NULL,
  output              TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'queued',
  model               TEXT NOT NULL DEFAULT '',
  usage_json          TEXT NOT NULL DEFAULT '{}',
  tool_calls_json     TEXT NOT NULL DEFAULT '[]',
  event_ids_json      TEXT NOT NULL DEFAULT '[]',
  dispatched_json     TEXT NOT NULL DEFAULT '[]',
  note_id             TEXT,
  error               TEXT,
  external_ref        TEXT,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT
);
CREATE INDEX IF NOT EXISTS director_turns_by_session ON director_turns(director_session_id, seq);

CREATE TABLE IF NOT EXISTS director_outbox (
  id                  TEXT PRIMARY KEY,
  director_session_id TEXT NOT NULL REFERENCES director_sessions(id),
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  seq                 INTEGER NOT NULL,
  kind                TEXT NOT NULL,
  ref_id              TEXT NOT NULL,
  dedupe_key          TEXT NOT NULL,
  cause_turn_id       TEXT,
  payload_json        TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'pending',
  attempts            INTEGER NOT NULL DEFAULT 0,
  delivered_turn_id   TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL,
  delivered_at        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS director_outbox_dedupe ON director_outbox(director_session_id, dedupe_key);
CREATE INDEX IF NOT EXISTS director_outbox_pending ON director_outbox(director_session_id, status, seq);
`)
  }],
  // the network became part of every session's default grant: sessions stored before keep no time-boxed or withheld
  // network. Grants that are not a JSON object are kept as stored (not replaced, so nothing is lost); they already
  // read as the default grants, which include the network.
  [11, (conn) => {
    conn.run(`UPDATE sessions SET grants_json = json_set(grants_json, '$.network', json('true'), '$.network_until', json('null'))
      WHERE ${GRANTS_READABLE}`)
    const kept = conn.all(`SELECT id FROM sessions WHERE NOT (${GRANTS_READABLE})`).map((r) => String(r.id))
    if (kept.length) console.warn(`migration v11: grants that are not a JSON object kept as stored for sessions ${kept.join(', ')}`)
  }],
  // runs no longer dispatch runs of their own: the collaboration graph and the dispatch columns go; a run an older
  // build left waiting on its children ends as an error
  [12, `
UPDATE runs SET status = 'error', error = 'the run waited for child runs, which this build no longer has', finished_at = COALESCE(finished_at, created_at) WHERE status = 'waiting';
DROP TABLE evidence;
DROP TABLE claims;
DROP TABLE interventions;
DROP TABLE messages;
DROP TABLE relation_grants;
DROP TABLE task_board;
DROP TABLE interactions;
ALTER TABLE runs DROP COLUMN can_dispatch;
ALTER TABLE runs DROP COLUMN director_prompt;
`],
  [13, `
ALTER TABLE runs ADD COLUMN relay_id TEXT;
ALTER TABLE runs ADD COLUMN relay_step INTEGER;
CREATE INDEX runs_by_relay ON runs(relay_id);
CREATE TABLE relays (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  status            TEXT NOT NULL DEFAULT 'running',
  user_text         TEXT NOT NULL,
  participants_json TEXT NOT NULL DEFAULT '[]',
  steps_json        TEXT NOT NULL DEFAULT '[]',
  rounds            INTEGER NOT NULL DEFAULT 1,
  round             INTEGER NOT NULL DEFAULT 1,
  current_step      INTEGER NOT NULL DEFAULT 0,
  reason            TEXT,
  thinking          TEXT,
  budget_json       TEXT NOT NULL DEFAULT '{}',
  mentions_json     TEXT NOT NULL DEFAULT '[]',
  attachments_json  TEXT NOT NULL DEFAULT '[]',
  client_request_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  finished_at       TEXT
);
CREATE INDEX relays_by_session ON relays(session_id, created_at);
CREATE UNIQUE INDEX relays_by_client_request ON relays(session_id, client_request_id) WHERE client_request_id IS NOT NULL;
`],
  // v14: the first turn's fresh / resumes_run_id ride with the relay. Two v13 databases exist: the first build's (no
  // such columns) and a later v13 that already had them; each column is added only where it is missing.
  [14, (conn) => {
    addColumnIfMissing(conn, 'relays', 'fresh', "INTEGER NOT NULL DEFAULT 0")
    addColumnIfMissing(conn, 'relays', 'resumes_run_id', 'TEXT')
  }],
  // v15: the interaction — one message to several agents run as a graph of nodes — and the run's place in one
  [15, `
ALTER TABLE runs ADD COLUMN interaction_id TEXT;
ALTER TABLE runs ADD COLUMN interaction_node TEXT;
CREATE INDEX runs_by_interaction ON runs(interaction_id);
CREATE TABLE interactions (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  status              TEXT NOT NULL DEFAULT 'planning',
  user_text           TEXT NOT NULL,
  participants_json   TEXT NOT NULL DEFAULT '[]',
  controller          TEXT NOT NULL DEFAULT 'director',
  template            TEXT,
  then_action         TEXT NOT NULL DEFAULT 'stop',
  revision            INTEGER NOT NULL DEFAULT 0,
  budget_json         TEXT NOT NULL DEFAULT '{}',
  run_budget_json     TEXT NOT NULL DEFAULT '{}',
  runs_started        INTEGER NOT NULL DEFAULT 0,
  base_checkpoint_id  TEXT,
  fresh               INTEGER NOT NULL DEFAULT 0,
  resumes_run_id      TEXT,
  thinking            TEXT,
  mentions_json       TEXT NOT NULL DEFAULT '[]',
  attachments_json    TEXT NOT NULL DEFAULT '[]',
  director_session_id TEXT,
  director_turn_id    TEXT,
  reason              TEXT,
  client_request_id   TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE INDEX interactions_by_session ON interactions(session_id, created_at);
CREATE UNIQUE INDEX interactions_by_client_request ON interactions(session_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE TABLE interaction_nodes (
  interaction_id  TEXT NOT NULL REFERENCES interactions(id),
  id              TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  participant     TEXT NOT NULL,
  instruction     TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  receives_json   TEXT NOT NULL DEFAULT '[]',
  workspace       TEXT NOT NULL DEFAULT 'own',
  status          TEXT NOT NULL DEFAULT 'queued',
  run_id          TEXT,
  run_ids_json    TEXT NOT NULL DEFAULT '[]',
  workspace_id    TEXT,
  revision        INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (interaction_id, id)
);
CREATE TABLE interaction_events (
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  actor          TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (interaction_id, seq)
);
`],
  // v16: the person's words to the participants while an interaction runs
  [16, `
CREATE TABLE interaction_notes (
  id             TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  to_participant TEXT NOT NULL,
  text           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',
  delivered_json TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX interaction_notes_by_interaction ON interaction_notes(interaction_id, created_at);
`],
  // v17: who named a session (a director's title replaces only one the person did not give); a copy that has the
  // column already keeps it
  [17, (conn) => { addColumnIfMissing(conn, 'sessions', 'title_source', "TEXT NOT NULL DEFAULT 'auto'") }],
  // v18: what an agent of the session's own conversation asked to be woken for, and what fired (a copy that has the
  // tables already keeps them)
  [18, `
CREATE TABLE IF NOT EXISTS watches (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  run_id        TEXT NOT NULL,
  spec_json     TEXT NOT NULL,
  note          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  repeats       INTEGER NOT NULL DEFAULT 0,
  cooldown_s    INTEGER NOT NULL DEFAULT 0,
  max_fires     INTEGER NOT NULL DEFAULT 1,
  fires         INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT,
  expires_at    TEXT NOT NULL,
  ended_reason  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS watches_by_session ON watches(session_id, created_at);
CREATE INDEX IF NOT EXISTS watches_by_status ON watches(status);
CREATE TABLE IF NOT EXISTS wake_events (
  id           TEXT PRIMARY KEY,
  watch_id     TEXT NOT NULL REFERENCES watches(id),
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  kind         TEXT NOT NULL,
  detail       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending',
  run_id       TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS wake_events_by_session ON wake_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS wake_events_by_status ON wake_events(status);
`],
  // v19: the journal of a folder edited in place: each file-tool write there, the file before and after (a copy
  // that has the table already keeps it)
  [19, `
CREATE TABLE IF NOT EXISTS file_journal (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  session_id    TEXT,
  run_id        TEXT,
  tool_call_id  TEXT,
  path          TEXT NOT NULL,
  action        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'prepared',
  before_exists INTEGER NOT NULL,
  before_blob   BLOB,
  before_sha    TEXT,
  after_blob    BLOB,
  after_sha     TEXT,
  undone_by     TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_journal_by_workspace ON file_journal(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS file_journal_by_run ON file_journal(run_id);
`],
  // v20: what a journalled write meant to leave (the sha of the bytes it writes; null for a removal), so a write the
  // harness stopped in the middle of is settled by the file, not by "it changed" (a copy that has it keeps it)
  [20, (conn) => { addColumnIfMissing(conn, 'file_journal', 'intended_sha', 'TEXT') }],
  // v21: Intelligent UI — the surfaces a run presented (one row per session, run and surface id: the latest revision,
  // the person's values) and the receipts of the actions the person prepared from them (one per request id)
  [21, `
CREATE TABLE IF NOT EXISTS ui_surfaces (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  run_id      TEXT NOT NULL REFERENCES runs(id),
  surface_id  TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  spec_json   TEXT NOT NULL,
  state_json  TEXT NOT NULL DEFAULT '{}',
  model       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, run_id, surface_id)
);
CREATE INDEX IF NOT EXISTS ui_surfaces_by_session ON ui_surfaces(session_id, created_at);
CREATE TABLE IF NOT EXISTS ui_action_receipts (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  run_id      TEXT NOT NULL,
  surface_id  TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  action_id   TEXT NOT NULL,
  payload_sha TEXT NOT NULL,
  state_json  TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ui_action_receipts_by_request ON ui_action_receipts(session_id, request_id);
`],
  // v22: Intelligent UI's interaction — the agent tasks a surface's `run` actions started (one per session and request
  // id: queued behind the conversation, then the run doing it, its data and result) and request_input's forms (one per
  // call: pending until the person answers, or the run ends)
  [22, `
CREATE TABLE IF NOT EXISTS ui_tasks (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  surface_run_id   TEXT NOT NULL,
  surface_id       TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  action_id        TEXT NOT NULL,
  request_id       TEXT NOT NULL,
  payload_sha      TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  agent_run_id     TEXT,
  status           TEXT NOT NULL,
  input_json       TEXT,
  text             TEXT NOT NULL DEFAULT '',
  data_json        TEXT,
  reported_ok      INTEGER,
  reported_message TEXT,
  error_json       TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ui_tasks_by_request ON ui_tasks(session_id, request_id);
CREATE INDEX IF NOT EXISTS ui_tasks_by_surface ON ui_tasks(session_id, surface_run_id, surface_id, created_at);
CREATE INDEX IF NOT EXISTS ui_tasks_by_status ON ui_tasks(status, session_id, created_at);
CREATE INDEX IF NOT EXISTS ui_tasks_by_agent_run ON ui_tasks(agent_run_id);
CREATE TABLE IF NOT EXISTS ui_inputs (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  run_id            TEXT NOT NULL REFERENCES runs(id),
  tool_call_id      TEXT NOT NULL,
  request_json      TEXT NOT NULL,
  status            TEXT NOT NULL,
  values_json       TEXT,
  closed_reason     TEXT,
  answer_request_id TEXT,
  created_at        TEXT NOT NULL,
  answered_at       TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ui_inputs_by_session ON ui_inputs(session_id, created_at);
CREATE INDEX IF NOT EXISTS ui_inputs_by_run ON ui_inputs(run_id, created_at);
CREATE INDEX IF NOT EXISTS ui_inputs_by_status ON ui_inputs(status);
`],
  // v23: session-scoped surfaces — a surface's scope (every row written before is `run`: none becomes a session
  // surface), the run that wrote its current revision (backfilled with its own run), one session surface per
  // (session, surface_id); and the journal of the revisions each run published (one row per revision: the anchor, the
  // revision, the run that wrote it), backfilled from the rows there are so a run's limits count as they did
  [23, (conn) => {
    addColumnIfMissing(conn, 'ui_surfaces', 'scope', "TEXT NOT NULL DEFAULT 'run'")
    addColumnIfMissing(conn, 'ui_surfaces', 'updated_by_run_id', 'TEXT')
    conn.exec(`
UPDATE ui_surfaces SET updated_by_run_id = run_id WHERE updated_by_run_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ui_surfaces_session_scope ON ui_surfaces(session_id, surface_id) WHERE scope = 'session';
CREATE TABLE IF NOT EXISTS ui_publications (
  session_id     TEXT NOT NULL,
  anchor_run_id  TEXT NOT NULL,
  surface_id     TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  writer_run_id  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (session_id, anchor_run_id, surface_id, revision)
);
CREATE INDEX IF NOT EXISTS ui_publications_by_writer ON ui_publications(writer_run_id);
INSERT OR IGNORE INTO ui_publications (session_id, anchor_run_id, surface_id, revision, writer_run_id, created_at)
  WITH RECURSIVE revs(session_id, run_id, surface_id, revision, last, created_at) AS (
    SELECT session_id, run_id, surface_id, 1, min(revision, 1000), created_at FROM ui_surfaces WHERE revision >= 1
    UNION ALL
    SELECT session_id, run_id, surface_id, revision + 1, last, created_at FROM revs WHERE revision < last
  )
  SELECT session_id, run_id, surface_id, revision, run_id, created_at FROM revs;
`)
  }],
  // v24: original director message envelope, durable dispatch ownership and workspace-level read-only sources.
  [24, (conn) => {
    addColumnIfMissing(conn, 'workspaces', 'source_mount_json', 'TEXT')
    addColumnIfMissing(conn, 'director_turns', 'envelope_json', 'TEXT')
    addColumnIfMissing(conn, 'director_turns', 'client_request_id', 'TEXT')
    addColumnIfMissing(conn, 'director_turns', 'dispatched_interactions_json', "TEXT NOT NULL DEFAULT '[]'")
    conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS director_turns_by_client_request ON director_turns(session_id, client_request_id) WHERE client_request_id IS NOT NULL')
    addColumnIfMissing(conn, 'interactions', 'workspace_policy', "TEXT NOT NULL DEFAULT 'legacy'")
    addColumnIfMissing(conn, 'interactions', 'source_turn_id', 'TEXT')
  }],
  // v25: the collaboration model — participants, conversations, typed edges; each new run's participant, conversation,
  // origin, placement and keyed intent (run_collab, beside runs); a node's kind, message, cites and receive_runs.
  // Additive: no row is updated, the runs table is not altered.
  [25, (conn) => {
    conn.exec(COLLAB_TABLES_SQL)
    addColumnIfMissing(conn, 'interaction_nodes', 'kind', "TEXT NOT NULL DEFAULT 'plan'")
    addColumnIfMissing(conn, 'interaction_nodes', 'message_json', 'TEXT')
    addColumnIfMissing(conn, 'interaction_nodes', 'cites_json', "TEXT NOT NULL DEFAULT '[]'")
    addColumnIfMissing(conn, 'interaction_nodes', 'receive_runs_json', "TEXT NOT NULL DEFAULT '[]'")
  }],
  // v26: the session cursor — every run event written takes the next value of one persisted counter (never reused,
  // unlike a rowid after its row is deleted or a table rebuilt); the rows before it take their rowid, in written order.
  // Each row names its run's session, so a session's events after a cursor are one index range
  [26, (conn) => {
    addColumnIfMissing(conn, 'run_events', 'cursor', 'INTEGER')
    addColumnIfMissing(conn, 'run_events', 'session_id', 'TEXT')
    conn.exec(`
UPDATE run_events SET cursor = rowid WHERE cursor IS NULL;
UPDATE run_events SET session_id = (SELECT r.session_id FROM runs r WHERE r.id = run_events.run_id) WHERE session_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS run_events_by_cursor ON run_events(cursor);
CREATE INDEX IF NOT EXISTS run_events_by_session_cursor ON run_events(session_id, cursor);
CREATE TABLE IF NOT EXISTS event_cursor (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  last INTEGER NOT NULL
);
INSERT OR IGNORE INTO event_cursor (id, last) VALUES (1, (SELECT COALESCE(MAX(cursor), 0) FROM run_events));
`)
  }],
  // v27: each session's latest activity (the rail's order), filled from what its rows hold — never from the finish a
  // restart wrote for a run it found lost. Added only where absent, filled only forward: running it twice is a no-op.
  [27, (conn) => {
    addColumnIfMissing(conn, 'sessions', 'last_activity_at', "TEXT NOT NULL DEFAULT ''")
    conn.exec('CREATE INDEX IF NOT EXISTS sessions_by_activity ON sessions(project_id, last_activity_at)')
    backfillSessionActivity(conn)
  }],
  // v28: each session's access (full | sandbox): every session already here runs its commands with full access from
  // now on, as a new one made by the app or the REST API does (api/sessions.ts) — set once, when the column is added,
  // so a session the person set to the sandbox since stays so. And the access cap of what a director of surface v1–v5
  // starts (runs, relays, interactions), kept in a table of its own beside them: none for what is already here.
  [28, (conn) => {
    if (addColumnIfMissing(conn, 'sessions', 'access_mode', "TEXT NOT NULL DEFAULT 'sandbox'")) conn.exec("UPDATE sessions SET access_mode = 'full'")
    conn.exec(`CREATE TABLE IF NOT EXISTS access_caps (
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  cap          TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_id)
)`)
  }],
  // v29: the task a session belongs to (null for every session already here: no historical session is regrouped) and
  // the folders a session reaches besides its working folder (none for what is already here). Nothing else changes:
  // no access, grant, cap or history row is rewritten.
  [29, (conn) => {
    addColumnIfMissing(conn, 'sessions', 'task_root_id', 'TEXT')
    conn.exec(`CREATE TABLE IF NOT EXISTS session_roots (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  path       TEXT NOT NULL,
  access     TEXT NOT NULL CHECK (access IN ('read', 'write')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
)`)
  }],
  [30, (conn) => {
    // Some historical test/branch databases already contain newer additive columns. Never rewrite their data.
    for (const sql of splitStatements(REMOTE_SCHEMA_SQL)) {
      const column = /^ALTER TABLE (\w+) ADD COLUMN (\w+) ([\s\S]+)$/i.exec(sql)
      if (column) addColumnIfMissing(conn, column[1]!, column[2]!, column[3]!)
      else conn.exec(sql.replace(/CREATE TABLE (?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS '))
    }
  }],
  // v31: the person's connect intent, apart from the transport's state. v30 wrote state='disconnected' both for a
  // Disconnect and at every graceful shutdown, and nothing else of v30 records which it was: such a target stays a
  // stop ('none': one Connect after the upgrade), even with a command still running on it. Every other state is one
  // only a Connect leaves behind (ready, connecting, error, auth_required, host_verification_required, unsupported):
  // the person asked for the connection. Set once, when the column is added; never rewritten after.
  [31, (conn) => {
    if (addColumnIfMissing(conn, 'ssh_targets', 'connect_intent', "TEXT NOT NULL DEFAULT 'none'")) {
      conn.exec("UPDATE ssh_targets SET connect_intent = 'connect' WHERE state IN ('ready', 'connecting', 'error', 'auth_required', 'host_verification_required', 'unsupported')")
    }
  }],
  [32, (conn) => { addColumnIfMissing(conn, 'model_requests', 'cost_cny', 'REAL') }],
  // v33: indexes for three reads, nothing else. A start's check for a run that ended without its run_finished event
  // (partial: only those rows are indexed); a workspace's commands in time order; a run's journal entries in time order
  // — the run_id index alone left them to be sorted whole, blobs included. That one is replaced: (run_id, created_at)
  // serves every lookup by run_id it served. No row is written, updated or removed.
  [33, `
CREATE INDEX IF NOT EXISTS run_events_finished_by_run ON run_events(run_id) WHERE event = 'run_finished';
CREATE INDEX IF NOT EXISTS executions_by_workspace ON executions(workspace_id, created_at);
DROP INDEX IF EXISTS file_journal_by_run;
CREATE INDEX file_journal_by_run ON file_journal(run_id, created_at);
`],
  // v34: live read-only session sharing — one row per link (contract/src/live_share.ts); its capability is never stored,
  // only the capability's sha256. A table of its own: no older row is read, written or removed.
  [34, `
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  label TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL,
  capability_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS share_links_by_session ON share_links(session_id, created_at);
`],
  // v35: a live link's protocol (every link already here: 1, as it was made) and the task a v2 link shows (none for
  // every link already here). Columns added only: no row is rewritten.
  [35, (conn) => {
    addColumnIfMissing(conn, 'share_links', 'protocol', 'INTEGER NOT NULL DEFAULT 1')
    addColumnIfMissing(conn, 'share_links', 'task_root_id', 'TEXT')
    conn.exec('CREATE INDEX IF NOT EXISTS share_links_by_task ON share_links(task_root_id, created_at)')
  }],
  [36, (conn) => {
    addColumnIfMissing(conn, 'sessions', 'pin_order', 'INTEGER CHECK (pin_order > 0)')
    conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS sessions_by_pin_order ON sessions(pin_order) WHERE pin_order IS NOT NULL')
    conn.run(SESSION_PIN_CLEANUP)
  }],
  // A derived covering index only; no message, run or history is rewritten.
  [37, RUN_READ_INDEX_SQL],
]

/** v25's tables and indexes, as schema.sql has them (a migrated database equals a fresh one). */
const COLLAB_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS run_collab (
  run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), participant_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  origin_json TEXT NOT NULL, placement_json TEXT NOT NULL, intent_sha TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_collab_by_participant ON run_collab(participant_id, created_at);
CREATE INDEX IF NOT EXISTS run_collab_by_conversation ON run_collab(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS run_collab_by_session ON run_collab(session_id, created_at);
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, alias TEXT, label TEXT NOT NULL DEFAULT '',
  model TEXT, group_kind TEXT, group_id TEXT, legacy_key TEXT NOT NULL, introduced_by_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS participants_by_session ON participants(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS participants_by_key ON participants(session_id, legacy_key);
CREATE UNIQUE INDEX IF NOT EXISTS participants_main ON participants(session_id) WHERE role = 'main';
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), participant_id TEXT NOT NULL REFERENCES participants(id),
  forked_from_run_id TEXT, fork_reason TEXT, root_run_id TEXT, head_run_id TEXT, tool_surface TEXT, tool_snapshot_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_by_participant ON conversations(participant_id, created_at);
CREATE TABLE IF NOT EXISTS collab_edges (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, from_kind TEXT NOT NULL, from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL, to_id TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS collab_edges_from ON collab_edges(session_id, from_kind, from_id);
CREATE INDEX IF NOT EXISTS collab_edges_to ON collab_edges(session_id, to_kind, to_id);
CREATE UNIQUE INDEX IF NOT EXISTS collab_edges_once ON collab_edges(kind, from_kind, from_id, to_kind, to_id);
`

export type Row = Record<string, unknown>
export type Param = string | number | bigint | boolean | null | Uint8Array

/** The one connection: `all` / `get` return finished rows, `run` returns the last row id and the change count. */
export class Conn {
  readonly db: Database
  readonly path: string

  constructor(db: Database, path: string) {
    this.db = db
    this.path = path
  }

  all(sql: string, params: Param[] = []): Row[] {
    return this.db.query(sql).all(...params) as Row[]
  }

  get(sql: string, params: Param[] = []): Row | null {
    return (this.db.query(sql).get(...params) as Row | null) ?? null
  }

  run(sql: string, params: Param[] = []): { lastInsertRowid: number; changes: number } {
    const result = this.db.query(sql).run(...params)
    return { lastInsertRowid: Number(result.lastInsertRowid), changes: Number(result.changes) }
  }

  /** Run a script of one or more statements, each on its own: bun:sqlite's exec() of several statements raises only
   *  the last one's failure and runs on past the others, so a failing statement must stop the script here. */
  exec(sql: string): void {
    for (const statement of splitStatements(sql)) this.db.run(statement)
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }
}

/** The statements of a SQL script, split at the semicolons that end them (not those inside quotes or comments), with
 *  the comment-only remainders dropped. A trigger body (BEGIN … END) is not recognised, and a
 *  split one fails loudly as incomplete input. Triggers are supplied whole through Conn.run instead. */
export function splitStatements(script: string): string[] {
  const statements: string[] = []
  let start = 0
  let code = false
  let i = 0
  while (i < script.length) {
    const c = script[i]!
    if (c === '-' && script[i + 1] === '-') {
      const end = script.indexOf('\n', i)
      i = end < 0 ? script.length : end + 1
    } else if (c === '/' && script[i + 1] === '*') {
      const end = script.indexOf('*/', i + 2)
      i = end < 0 ? script.length : end + 2
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      i += 1
      while (i < script.length) {
        if (script[i] === close) {
          if (close !== ']' && script[i + 1] === close) { i += 2; continue }   // a doubled quote is one quote character
          break
        }
        i += 1
      }
      i += 1
      code = true
    } else if (c === ';') {
      if (code) statements.push(script.slice(start, i).trim())
      start = i + 1
      code = false
      i += 1
    } else {
      if (!/\s/.test(c)) code = true
      i += 1
    }
  }
  if (code) statements.push(script.slice(start).trim())
  return statements
}

export function connect(path: string): Conn {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  const conn = new Conn(db, path)
  try {
    conn.exec('PRAGMA busy_timeout=5000')
    conn.exec('PRAGMA journal_mode=WAL')
    conn.exec('PRAGMA foreign_keys=ON')
    ensureSchema(conn)
  } catch (error) {
    db.close()
    throw error
  }
  return conn
}

/** Bring the database to SCHEMA_VERSION. Each step is one IMMEDIATE transaction that writes user_version last: a
 *  statement that fails rolls the step back whole and the error surfaces, so the version on disk never names a step
 *  that did not happen. The version is read again under the write lock, so a step another process finished meanwhile
 *  is not run twice. */
function ensureSchema(conn: Conn): void {
  const version = (): number => Number((conn.get('PRAGMA user_version') as { user_version: number }).user_version)
  const from = version()
  let reached = from
  if (from > SCHEMA_VERSION) throw new Error(`database schema v${from} is newer than this build (v${SCHEMA_VERSION})`)
  const step = (target: number, apply: () => void, applies: () => boolean): void => {
    try {
      conn.db.transaction(() => {
        if (!applies()) return
        apply()
        conn.exec(`PRAGMA user_version = ${target}`)
      }).immediate()
    } catch (error) {
      throw describeMigrationError(conn, error, reached, target)
    }
    reached = target
  }
  const empty = (): boolean => version() === 0
    && Number((conn.get("SELECT count(*) AS n FROM sqlite_master WHERE type='table'") as { n: number }).n) === 0
  if (from === 0 && empty()) {
    step(SCHEMA_VERSION, () => { conn.exec(SCHEMA_SQL); conn.run(SESSION_PIN_CLEANUP) }, empty)
  } else {
    if (from > 0 && from < SCHEMA_VERSION) {
      const backup = backUpBeforeUpgrade(conn, from)
      if (backup !== null) console.warn(`database at schema v${from} copied to ${backup} before its upgrade to v${SCHEMA_VERSION}`)
    }
    for (const [target, body] of MIGRATIONS) {
      if (target <= from) continue
      step(target, () => (typeof body === 'string' ? conn.exec(body) : body(conn)), () => version() < target)
    }
  }
  repairKnownColumns(conn)
}

/** The copy before an upgrade could not be made, so the database was left as it was: a start that cannot go on, said
 *  in one line (its message names the database, the step and what to check). */
export class UpgradeBackupFailed extends Error {}

/** A consistent copy of the database as it is before an upgrade (`VACUUM INTO`, so a write of another connection is
 *  either in it whole or not at all), written beside it as `<name>.v<from>.bak` through a temporary file; the copies of
 *  earlier upgrades are removed once it is there. Its path, or null for a database that lives only in memory. A copy
 *  that cannot be made stops the upgrade: the person's only way back to the older build is this copy. */
export function backUpBeforeUpgrade(conn: Conn, from: number): string | null {
  if (conn.path === ':memory:' || conn.path === '') return null
  const dir = dirname(conn.path)
  const name = basename(conn.path)
  const target = join(dir, `${name}.v${from}.bak`)
  const partial = `${target}.partial`
  try {
    rmSync(partial, { force: true })
    conn.db.run('VACUUM INTO ?', [partial])
    renameSync(partial, target)
  } catch (error) {
    rmSync(partial, { force: true })
    throw new UpgradeBackupFailed(`the database at schema v${from} could not be copied before its upgrade to v${SCHEMA_VERSION}, so it was not upgraded (${(error as Error).message}); check that ${dir} is writable and has room, and start again`, { cause: error })
  }
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(name) && /^\.v\d+\.bak$/.test(entry.slice(name.length)) && join(dir, entry) !== target) rmSync(join(dir, entry), { force: true })
  }
  return target
}

/** The error of a step that did not happen, saying which step and, when another connection holds the write lock, that
 *  this is what stopped it (SQLite's own words for that name neither the file nor the step). */
function describeMigrationError(conn: Conn, error: unknown, onDisk: number, target: number): Error {
  const code = (error as { code?: unknown }).code
  const message = error instanceof Error ? error.message : String(error)
  const busy = typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  const cause = busy
    ? `another process holds the database's write lock (${message}); close any other oasis-code using ${conn.path} and start again`
    : message
  return new Error(`database upgrade to schema v${target} failed and was rolled back (the database stays at v${onDisk}): ${cause}`, { cause: error })
}

/** Columns a database may lack whatever its version says (a v13 of the first build opened by a later v13 that had
 *  them, a hand-rewound copy): added where missing, on every open, at no cost when present. */
export function repairKnownColumns(conn: Conn): string[] {
  const added: string[] = []
  if (addColumnIfMissing(conn, 'relays', 'fresh', 'INTEGER NOT NULL DEFAULT 0')) added.push('relays.fresh')
  if (addColumnIfMissing(conn, 'relays', 'resumes_run_id', 'TEXT')) added.push('relays.resumes_run_id')
  return added
}
