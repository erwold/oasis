-- oasis-code schema v2 (v1 + the run tree's columns on runs). New tables only:
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
  updated_at         TEXT NOT NULL
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
  director_prompt     TEXT
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
