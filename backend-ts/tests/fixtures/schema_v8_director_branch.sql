-- schema.sql as commit 1fe5d21 (the director-session branch) left it: its v8 is not main's v8
-- oasis-code schema v8 (v1 + the run tree's columns on runs + the governance log + director notes + the collaboration graph + the director session). New tables only:
-- nothing of the 3D product's schema comes along. Append-only where the record is evidence
-- (run_events, model_requests, snapshots, checkpoints, checks).

CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  source_path        TEXT,
  base_repo_path     TEXT NOT NULL,
  base_commit        TEXT,
  base_branch        TEXT,
  import_report_json TEXT NOT NULL DEFAULT '{}',
  default_model      TEXT,
  config_json        TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  -- schema v6: snapshot (the folder copied into base.git at import) or attached (read as it stands, never copied)
  kind               TEXT NOT NULL DEFAULT 'snapshot'
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  title        TEXT NOT NULL,
  workspace_id TEXT,
  model        TEXT NOT NULL,
  grants_json  TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX sessions_by_project ON sessions(project_id, updated_at);

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  session_id  TEXT,
  path        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'task',
  created_at  TEXT NOT NULL
);

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  project_id          TEXT NOT NULL REFERENCES projects(id),
  workspace_id        TEXT,
  parent_run_id       TEXT,
  resumes_run_id      TEXT,
  spawned_by          TEXT NOT NULL DEFAULT 'human',
  label               TEXT,
  model               TEXT NOT NULL,
  model_config_json   TEXT NOT NULL DEFAULT '{}',
  user_text           TEXT NOT NULL,
  status              TEXT NOT NULL,
  history_json        TEXT,
  usage_json          TEXT NOT NULL DEFAULT '{}',
  manifest_json       TEXT NOT NULL DEFAULT '{}',
  budget_json         TEXT NOT NULL DEFAULT '{}',
  receipt_json        TEXT NOT NULL DEFAULT '{}',
  error               TEXT,
  created_at          TEXT NOT NULL,
  finished_at         TEXT,
  saved_seq           INTEGER NOT NULL DEFAULT 0,
  -- the run tree (schema v2): the order a run works under, whether it may dispatch child runs, and the
  -- person's own director preamble for a thread run that may
  work_order_json     TEXT,
  can_dispatch        INTEGER NOT NULL DEFAULT 0,
  director_prompt     TEXT,
  -- the images attached to the run's message (schema v7): references to the session's assets
  attachments_json    TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX runs_by_session ON runs(session_id, created_at);
CREATE INDEX runs_by_status ON runs(status);
CREATE INDEX runs_by_parent ON runs(parent_run_id);

CREATE TABLE run_events (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  seq        INTEGER NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  event      TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE model_requests (
  id                      TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES runs(id),
  seq                     INTEGER NOT NULL,
  model_id                TEXT NOT NULL,
  configured_model        TEXT NOT NULL,
  provider_reported_model TEXT,
  endpoint                TEXT NOT NULL,
  started_at              TEXT NOT NULL,
  latency_ms              INTEGER,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd                REAL,
  cost_status             TEXT NOT NULL DEFAULT 'unknown',
  cost_source             TEXT,
  status                  TEXT NOT NULL DEFAULT 'ok',
  error                   TEXT,
  tool_schema_sha256      TEXT,
  message_count           INTEGER NOT NULL DEFAULT 0,
  context_estimate_tokens INTEGER
);
CREATE INDEX model_requests_by_run ON model_requests(run_id, seq);

CREATE TABLE executions (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  workspace_id    TEXT,
  tool_call_id    TEXT,
  kind            TEXT NOT NULL,
  command         TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  status          TEXT NOT NULL,
  effect_state    TEXT NOT NULL DEFAULT 'not_started',
  exit_code       INTEGER,
  timed_out       INTEGER NOT NULL DEFAULT 0,
  cancelled       INTEGER NOT NULL DEFAULT 0,
  truncated       INTEGER NOT NULL DEFAULT 0,
  stdout_asset_id TEXT,
  stderr_asset_id TEXT,
  stdout_bytes    INTEGER NOT NULL DEFAULT 0,
  stderr_bytes    INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  finished_at     TEXT,
  duration_ms     INTEGER,
  isolation_json  TEXT NOT NULL DEFAULT '{}',
  network         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX executions_by_run ON executions(run_id, created_at);

CREATE TABLE snapshots (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  base_commit    TEXT NOT NULL,
  tree_sha       TEXT NOT NULL,
  file_count     INTEGER NOT NULL,
  untracked_json TEXT NOT NULL DEFAULT '[]',
  excluded_json  TEXT NOT NULL DEFAULT '[]',
  changed_json   TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL
);
CREATE INDEX snapshots_by_workspace ON snapshots(workspace_id, created_at);

CREATE TABLE checkpoints (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  run_id               TEXT,
  snapshot_id          TEXT NOT NULL REFERENCES snapshots(id),
  commit_sha           TEXT NOT NULL,
  ref                  TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  note                 TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL
);
CREATE INDEX checkpoints_by_workspace ON checkpoints(workspace_id, created_at);

CREATE TABLE checks (
  id             TEXT PRIMARY KEY,
  run_id         TEXT,
  workspace_id   TEXT NOT NULL,
  snapshot_id    TEXT NOT NULL,
  check_id       TEXT NOT NULL,
  command        TEXT NOT NULL,
  exit_code      INTEGER,
  duration_ms    INTEGER,
  log_asset_id   TEXT,
  parser         TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  counts_json    TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX checks_by_workspace ON checks(workspace_id, created_at);

CREATE TABLE assets (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  kind         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  meta_json    TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX assets_by_project ON assets(project_id, kind);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  run_id        TEXT,
  tool_call_id  TEXT,
  action        TEXT NOT NULL,
  params_json   TEXT NOT NULL DEFAULT '{}',
  params_sha256 TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE INDEX approvals_by_session ON approvals(session_id, status);

-- schema v3: the governance log — append-only; the effective run control, session locks and proposal decisions
-- are DERIVED from the latest matching entry, never stored as mutable state (carried from oasis's operations log)
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

-- schema v4: director notes — one exchange of a conversation held outside this program (ChatGPT as the director,
-- through the director endpoint) mirrored into the session's thread: the person's question and the director's
-- answer, as they were; no run, no model request of this harness
CREATE TABLE director_notes (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  source     TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  question   TEXT NOT NULL DEFAULT '',
  answer     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- schema v8: the director turn this note closed (when the harness held the conversation)
  turn_id    TEXT
);
CREATE INDEX director_notes_by_session ON director_notes(session_id, created_at);

-- schema v5: the collaboration graph. Resources and permissions stay a tree (runs.parent_run_id, grants, budgets,
-- cancellation); these tables are the graph beside it: who may observe / message / challenge / ask to intervene on
-- whom, the interactions those relations serve, the messages between runs, the claims and the evidence for or
-- against them, the interventions asked for and decided, and the task board.
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

-- schema v8: the director session. The harness holds the main conversation with a director outside its own agents
-- (a model route it runs itself, the ChatGPT web app through a browser bridge, an OpenAI Workspace Agent) and
-- continues it itself: a turn per message and answer; an outbox of the task events (a run finished) that wait to
-- be delivered as the next turn — persisted, so a restart loses none and a retry repeats none.
CREATE TABLE director_sessions (
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
CREATE INDEX director_sessions_by_session ON director_sessions(session_id, created_at);

CREATE TABLE director_turns (
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
CREATE INDEX director_turns_by_session ON director_turns(director_session_id, seq);

CREATE TABLE director_outbox (
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
CREATE UNIQUE INDEX director_outbox_dedupe ON director_outbox(director_session_id, dedupe_key);
CREATE INDEX director_outbox_pending ON director_outbox(director_session_id, status, seq);
