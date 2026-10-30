-- v30: local rows keep NULL target bindings; remote identities are never inferred from paths.
CREATE TABLE ssh_targets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  destination TEXT NOT NULL,
  port INTEGER,
  identity_file TEXT,
  state TEXT NOT NULL DEFAULT 'disconnected',
  generation TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL
);
ALTER TABLE projects ADD COLUMN target_id TEXT REFERENCES ssh_targets(id);
ALTER TABLE projects ADD COLUMN remote_binding_json TEXT;
ALTER TABLE workspaces ADD COLUMN target_id TEXT REFERENCES ssh_targets(id);
ALTER TABLE workspaces ADD COLUMN remote_binding_json TEXT;
ALTER TABLE session_roots ADD COLUMN target_id TEXT REFERENCES ssh_targets(id);
ALTER TABLE session_roots ADD COLUMN root_id TEXT;
ALTER TABLE session_roots ADD COLUMN generation TEXT;
CREATE TABLE remote_jobs (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id),
  target_id TEXT NOT NULL REFERENCES ssh_targets(id),
  root_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  job_id TEXT,
  state TEXT NOT NULL DEFAULT 'unknown',
  connection_state TEXT NOT NULL DEFAULT 'disconnected',
  stdout_offset INTEGER NOT NULL DEFAULT 0,
  stderr_offset INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(target_id, root_id, generation, operation_id)
);
CREATE TABLE remote_journal_operations (
  journal_id TEXT PRIMARY KEY REFERENCES file_journal(id),
  target_id TEXT NOT NULL REFERENCES ssh_targets(id),
  root_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared',
  UNIQUE(target_id, root_id, generation, operation_id)
);
CREATE TABLE remote_watch_cursors (
  watch_id TEXT NOT NULL REFERENCES watches(id),
  stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')),
  byte_offset INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(watch_id, stream)
);
