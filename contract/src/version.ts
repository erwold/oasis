/** The versions the two ends of the contract agree on. Only API_VERSION blocks a page; the rest are pinned by tests. */

/** The API compatibility version: a page or a director that speaks another one is refused. */
export const API_VERSION = 'code-v1'
/** The SQLite schema (`PRAGMA user_version`); a migrated database equals a fresh one. v5 adds the collaboration
 *  graph's tables (interactions, messages, relation grants, claims, evidence, interventions, the task board); v6 adds
 *  `projects.kind` (snapshot | attached: a folder read as it stands, never snapshotted); v7 adds `runs.attachments_json`
 *  (the images attached to a run's message, as references to the session's assets); v8 adds `runs.client_request_id`
 *  (a chat's idempotency key, unique within its session); v9 adds `projects.client_request_id` and
 *  `sessions.client_request_id` (the start screen's keys: one folder imported once, one session made once); v10 adds the director session
 *  (`director_sessions`, `director_turns`, `director_outbox`) and `director_notes.turn_id`; v11 turns the network on in
 *  every stored session's grants (the network became part of the default grant); v12 drops the collaboration graph's
 *  tables and `runs.can_dispatch` / `runs.director_prompt` (runs no longer dispatch runs of their own); v13 adds the
 *  relay (`relays`: one message to several agents who take turns on it) and `runs.relay_id` / `runs.relay_step`; v14 adds
 *  `relays.fresh` and `relays.resumes_run_id` (added only where a v13 database lacks them: two v13 shapes exist); v15
 *  adds the interaction (`interactions`, `interaction_nodes`, `interaction_events`: one message to several agents run
 *  as a graph of nodes) and `runs.interaction_id` / `runs.interaction_node`; v16 adds `interaction_notes` (the person's
 *  words to the participants while an interaction runs, handed at their next runs); v17 adds `sessions.title_source`;
 *  v18 adds the watches (`watches`, `wake_events`: what an agent asked to be woken for, and what fired); v19 adds the
 *  journal of a folder edited in place (`file_journal`: each file-tool write there, the file before and after); v20
 *  adds `file_journal.intended_sha` (what a write meant to leave, so a stop mid-write is settled by the file); v21 adds
 *  Intelligent UI (`ui_surfaces`: the surfaces a run presented, the latest revision and the person's values;
 *  `ui_action_receipts`: the actions the person prepared from them, one per request id); v22 adds Intelligent UI's
 *  interaction (`ui_tasks`: the agent tasks a surface's `run` actions started, one per request id; `ui_inputs`: the
 *  forms request_input showed and their answers); v23 adds Intelligent UI's session surfaces (`ui_surfaces.scope`, `run`
 *  for every row before it, and `ui_surfaces.updated_by_run_id`; one `session` surface per (session, surface_id); a
 *  journal of each publication — anchor, revision, writing run, time — so a run's present_ui budget counts its own). */
/** v24: original director envelopes, routed interaction ownership and workspace-level live read-only sources.
 *  v25 (COLLAB_SCHEMA_VERSION, collab_core.ts): the collaboration model — `participants`, `conversations`,
 *  `collab_edges`; each run's participant, conversation, origin, placement and dispatch intent; an interaction node's
 *  kind, message, cites and receive_runs. Additive: no older row is rewritten (they are projected when read).
 *  v26: `run_events.cursor` and `event_cursor` — one persisted counter over every run event written, never reused, the
 *  cursor a session's one event stream resumes after (events.ts SESSION_STREAM_READY).
 *  v27: `sessions.last_activity_at` (and its index): a session's latest activity — a run started or finished, words
 *  sent, a call to its director — the rail's order; filled for every older session from its rows, never from what a
 *  restart's recovery wrote.
 *  v28: `sessions.access_mode` (full | sandbox; every older session sandbox, as it ran) and `access_caps`: the cap of
 *  a run, a relay or an interaction (sandbox for what a director of surface v1–v5 started, inherited by what continues
 *  it), in a table of its own beside them.
 *  v29: `sessions.task_root_id` (the task a session belongs to, by its first session; null for every older session:
 *  no historical regrouping) and `session_roots` (folders besides the working folder a session reaches, each read or
 *  write). Additive: no older row is rewritten. */
/** v30: SSH identities, root bindings, durable remote job records and journal/watch cursors.
 *  v31: `ssh_targets.connect_intent` (none | connect | disconnect): the person's Connect or Disconnect, kept apart
 *  from the transport's `state` so a shutdown, a crash or a lost network never reads as a Disconnect. A v30 target's
 *  state can say only part of it: one a Connect left (ready, connecting, error, auth_required,
 *  host_verification_required, unsupported) becomes `connect`; `disconnected` — written by a Disconnect and by every
 *  v30 shutdown alike — stays a stop (`none`) until the person presses Connect once. */
/** v32: currency-separated CNY model-request estimates; historical requests remain null.
 *  v33: indexes only — `run_events_finished_by_run` (partial, run_finished rows), `executions_by_workspace`
 *  (workspace_id, created_at), and `file_journal_by_run` widened to (run_id, created_at). No row is rewritten.
 *  v34: `share_links` (live read-only session sharing, contract/src/live_share.ts): one row per link — its session, its
 *  fixed options, its expiry and revocation, and only a hash of its capability. Additive: no older row is touched.
 *  v35: `share_links.protocol` (1 for every older link; 2: the live state v2) and `share_links.task_root_id` (the task a
 *  v2 link shows, fixed when it is made; NULL for a link of one session). Columns added only.
 *  v36: `sessions.pin_order`, a stable append order independent of activity; leaving open clears it.
 *  v37: `runs_read`, a history-free covering index for session run reads; no stored content changes. */
export const SCHEMA_VERSION = 37
/** The run events' record version (`run_events.version`). */
export const EVENT_VERSION = 1
/** The receipt's shape (`Receipt.version`). */
export const RECEIPT_VERSION = 3
/** The work order's shape (`WorkOrder.version`). */
export const WORK_ORDER_VERSION = 3
/** The run manifest's shape (`runs.manifest_json.version`). */
export const MANIFEST_VERSION = 'run_manifest.v4'
/** The context report's shape. */
export const CONTEXT_REPORT_SCHEMA = 'context_report.v2'
/** The persisted message model (`runs.history_json`): the harness's own JSON, kept compatible with the shape the
 *  first (Python) backend stored, so one data directory serves both backends and no migration is needed. */
export const HISTORY_FORMAT = 'history.v1'
/** An action proposal (the Action Gate). */
export const PROPOSAL_SCHEMA = 'agent_action_proposal.v1'
/** A fetched page kept as a report asset. */
export const WEB_FETCH_SCHEMA = 'web_fetch.v1'
