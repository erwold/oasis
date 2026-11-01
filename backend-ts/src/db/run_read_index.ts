/** v37: cover collaboration metadata/fingerprint reads without walking history_json overflow pages to reach later columns. The history
 * stays solely in the table; only its exact empty-record verdict is indexed. Keep in step with schema.sql and
 * collab_repo META_COLUMNS. Usage, manifests, attachments and full receipts are deliberately not duplicated. Updates are maintained atomically by SQLite, not an eventually consistent cache. */
export const RUN_READ_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS runs_read ON runs (
  session_id, created_at, id, project_id, workspace_id, parent_run_id,
  resumes_run_id, spawned_by, label, model, user_text, status, error,
  finished_at, work_order_json, client_request_id, relay_id, relay_step, interaction_id, interaction_node,
  (CASE WHEN octet_length(history_json) > 4 THEN 0
    ELSE (history_json IS NULL OR history_json = '' OR history_json = '[]') END),
  length(json_extract(CASE WHEN json_valid(receipt_json) THEN receipt_json ELSE '{}' END, '$.final_text'))
);
`
