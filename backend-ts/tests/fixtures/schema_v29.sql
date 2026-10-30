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
  kind               TEXT NOT NULL DEFAULT 'snapshot',
  -- schema v9: the start screen's key (one folder imported once however often the request is sent)
  client_request_id  TEXT
);
CREATE UNIQUE INDEX projects_by_client_request ON projects(client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  title        TEXT NOT NULL,
  workspace_id TEXT,
  model        TEXT NOT NULL,
  grants_json  TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  -- schema v9: the start screen's key (one session made once)
  client_request_id TEXT,
  -- schema v17: who named it — auto (from the first words), director (its plan's title), person
  title_source TEXT NOT NULL DEFAULT 'auto',
  -- schema v27: the latest activity in it (a run started or finished, words sent, a call to its director); never a
  -- rename, a setting, or what a restart's recovery wrote — the rail's order
  last_activity_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_by_project ON sessions(project_id, updated_at);
CREATE INDEX sessions_by_activity ON sessions(project_id, last_activity_at);
CREATE UNIQUE INDEX sessions_by_client_request ON sessions(project_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  session_id  TEXT,
  path        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'task',
  created_at  TEXT NOT NULL,
  source_mount_json TEXT
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
  -- the work order a run works under (schema v2)
  work_order_json     TEXT,
  -- the images attached to the run's message (schema v7): references to the session's assets
  attachments_json    TEXT NOT NULL DEFAULT '[]',
  -- a chat's idempotency key (schema v8): the same key in the same session is the same run
  client_request_id   TEXT,
  -- the relay this run is a turn of, and which turn (schema v13)
  relay_id            TEXT,
  relay_step          INTEGER,
  -- the interaction this run is a node of, and which node (schema v15)
  interaction_id      TEXT,
  interaction_node    TEXT
);
CREATE INDEX runs_by_session ON runs(session_id, created_at);
CREATE INDEX runs_by_relay ON runs(relay_id);
CREATE INDEX runs_by_interaction ON runs(interaction_id);
CREATE UNIQUE INDEX runs_by_client_request ON runs(session_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX runs_by_status ON runs(status);
CREATE INDEX runs_by_parent ON runs(parent_run_id);

CREATE TABLE run_events (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  seq        INTEGER NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  event      TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- the session cursor (schema v26): event_cursor's counter when the row was written, never reused (a VACUUM keeps it)
  cursor     INTEGER,
  -- the run's session (schema v26), so a session's events after a cursor are one range of an index
  session_id TEXT,
  PRIMARY KEY (run_id, seq)
);
CREATE UNIQUE INDEX run_events_by_cursor ON run_events(cursor);
CREATE INDEX run_events_by_session_cursor ON run_events(session_id, cursor);
-- the one counter run_events.cursor is taken from (schema v26): it only goes up, whatever is deleted
CREATE TABLE event_cursor (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  last INTEGER NOT NULL
);
INSERT INTO event_cursor (id, last) VALUES (1, 0);

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
ALTER TABLE director_turns ADD COLUMN envelope_json TEXT;
ALTER TABLE director_turns ADD COLUMN client_request_id TEXT;
ALTER TABLE director_turns ADD COLUMN dispatched_interactions_json TEXT NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX director_turns_by_client_request ON director_turns(session_id, client_request_id) WHERE client_request_id IS NOT NULL;
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

-- schema v13: the relay — one message of the person to several agents who take turns on it (the first does the task,
-- the next reviews it; a further round hands the feedback back). The chain's plan and state live here, not in a
-- browser: a restart finds a running relay and marks it interrupted; nothing starts on its own after that.
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
  finished_at       TEXT,
  -- schema v14: the first turn starts a new conversation / continues a named run (last: a migrated table appends them)
  fresh             INTEGER NOT NULL DEFAULT 0,
  resumes_run_id    TEXT
);
CREATE INDEX relays_by_session ON relays(session_id, created_at);
CREATE UNIQUE INDEX relays_by_client_request ON relays(session_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- schema v15: the interaction — one message of the person to several agents, run as a graph of nodes the harness
-- schedules: each node one run of one participant, started when the nodes it depends on have ended, handed the
-- answers of the nodes it receives; the plan is the director's (its schedule tool) or a fixed template's. The graph
-- and its state live here, not in a browser: a restart finds a running interaction and marks it interrupted.
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
ALTER TABLE interactions ADD COLUMN workspace_policy TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE interactions ADD COLUMN source_turn_id TEXT;
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

-- schema v16: the person's words to the participants while an interaction runs — queued, handed to each addressee at
-- its next run's start, never into a request in flight
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
CREATE TABLE watches (
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
CREATE INDEX watches_by_session ON watches(session_id, created_at);
CREATE INDEX watches_by_status ON watches(status);
CREATE TABLE wake_events (
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
CREATE INDEX wake_events_by_session ON wake_events(session_id, created_at);
CREATE INDEX wake_events_by_status ON wake_events(status);
CREATE TABLE file_journal (
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
  created_at    TEXT NOT NULL,
  intended_sha  TEXT
);
CREATE INDEX file_journal_by_workspace ON file_journal(workspace_id, created_at);
CREATE INDEX file_journal_by_run ON file_journal(run_id);
CREATE TABLE ui_surfaces (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  run_id      TEXT NOT NULL REFERENCES runs(id),
  surface_id  TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  spec_json   TEXT NOT NULL,
  state_json  TEXT NOT NULL DEFAULT '{}',
  model       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'run',
  updated_by_run_id TEXT,
  PRIMARY KEY (session_id, run_id, surface_id)
);
CREATE INDEX ui_surfaces_by_session ON ui_surfaces(session_id, created_at);
CREATE UNIQUE INDEX ui_surfaces_session_scope ON ui_surfaces(session_id, surface_id) WHERE scope = 'session';
CREATE TABLE ui_publications (
  session_id     TEXT NOT NULL,
  anchor_run_id  TEXT NOT NULL,
  surface_id     TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  writer_run_id  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (session_id, anchor_run_id, surface_id, revision)
);
CREATE INDEX ui_publications_by_writer ON ui_publications(writer_run_id);
CREATE TABLE ui_action_receipts (
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
CREATE UNIQUE INDEX ui_action_receipts_by_request ON ui_action_receipts(session_id, request_id);
CREATE TABLE ui_tasks (
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
CREATE UNIQUE INDEX ui_tasks_by_request ON ui_tasks(session_id, request_id);
CREATE INDEX ui_tasks_by_surface ON ui_tasks(session_id, surface_run_id, surface_id, created_at);
CREATE INDEX ui_tasks_by_status ON ui_tasks(status, session_id, created_at);
CREATE INDEX ui_tasks_by_agent_run ON ui_tasks(agent_run_id);
CREATE TABLE ui_inputs (
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
CREATE INDEX ui_inputs_by_session ON ui_inputs(session_id, created_at);
CREATE INDEX ui_inputs_by_run ON ui_inputs(run_id, created_at);
CREATE INDEX ui_inputs_by_status ON ui_inputs(status);

-- schema v25: the collaboration model (docs/multi-agent-unification-design.md §9). Additive: older rows keep every
-- byte; their participant / conversation / origin / placement are projected when read, never written back.
-- a run's place in the collaboration model, one row per run a v25 backend started (a run without one is older and
-- projected): who it belongs to, which conversation it appends to, why it started, where it is shown, and what a
-- keyed dispatch asked for (its fingerprint: the same key with another intent is refused, never answered with the
-- first one's run). A table beside runs, so no runs row — nor its table — changes.
CREATE TABLE run_collab (
  run_id          TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  participant_id  TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  origin_json     TEXT NOT NULL,
  placement_json  TEXT NOT NULL,
  intent_sha      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX run_collab_by_participant ON run_collab(participant_id, created_at);
CREATE INDEX run_collab_by_conversation ON run_collab(conversation_id, created_at);
CREATE INDEX run_collab_by_session ON run_collab(session_id, created_at);
CREATE TABLE participants (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  role               TEXT NOT NULL,
  alias              TEXT,
  label              TEXT NOT NULL DEFAULT '',
  model              TEXT,
  group_kind         TEXT,
  group_id           TEXT,
  legacy_key         TEXT NOT NULL,
  introduced_by_json TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX participants_by_session ON participants(session_id, created_at);
CREATE UNIQUE INDEX participants_by_key ON participants(session_id, legacy_key);
CREATE UNIQUE INDEX participants_main ON participants(session_id) WHERE role = 'main';
CREATE TABLE conversations (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  participant_id     TEXT NOT NULL REFERENCES participants(id),
  forked_from_run_id TEXT,
  fork_reason        TEXT,
  root_run_id        TEXT,
  head_run_id        TEXT,
  tool_surface       TEXT,
  -- the tool list every request of the conversation carries (names, descriptions, parameter schemas), fixed by its
  -- first run: a later run of it is given exactly these, whatever the registry or an order says since
  tool_snapshot_json TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX conversations_by_participant ON conversations(participant_id, created_at);
CREATE TABLE collab_edges (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind       TEXT NOT NULL,
  from_kind  TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_kind    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  meta_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX collab_edges_from ON collab_edges(session_id, from_kind, from_id);
CREATE INDEX collab_edges_to ON collab_edges(session_id, to_kind, to_id);
CREATE UNIQUE INDEX collab_edges_once ON collab_edges(kind, from_kind, from_id, to_kind, to_id);
ALTER TABLE interaction_nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'plan';
ALTER TABLE interaction_nodes ADD COLUMN message_json TEXT;
ALTER TABLE interaction_nodes ADD COLUMN cites_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE interaction_nodes ADD COLUMN receive_runs_json TEXT NOT NULL DEFAULT '[]';
-- schema v28: where a session's commands run (full | sandbox; a session from before it: full, set by the upgrade), and the
-- access cap of what a director of surface v1–v5 started (sandbox) — a run, a relay, an interaction — kept beside them
-- (a row per capped subject; none: no cap)
ALTER TABLE sessions ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'sandbox';
CREATE TABLE access_caps (
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  cap          TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_id)
);
-- schema v29: the task a session belongs to, by its first session's id (null: its own task's first — every session from
-- before v29, never regrouped), and the folders a session reaches besides its working folder, each read or write (the
-- real absolute path the person or a director registered; file tools and commands reach it by that path)
ALTER TABLE sessions ADD COLUMN task_root_id TEXT;
CREATE TABLE session_roots (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  path       TEXT NOT NULL,
  access     TEXT NOT NULL CHECK (access IN ('read', 'write')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);
