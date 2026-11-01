/** v38's optional, source-invalidated own-history projection. history_json remains the source of truth.
 * No read writes/rebuilds a projection. Missing/invalidated rows simply use the original transcript reader. */
import { isDeepStrictEqual } from 'node:util'
import { isModelMessages } from '../llm/messages.ts'
import { danglingToolCalls, lastCompactionIndex } from '../llm/history_shape.ts'
import type { Conn } from './database.ts'

export const HISTORY_PROJECTION_TABLE = `CREATE TABLE IF NOT EXISTS run_history_projection (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  continuation_count INTEGER,
  message_count INTEGER NOT NULL,
  own_offset INTEGER NOT NULL,
  own_json TEXT
);`
// Do not compare two multi-megabyte histories in a trigger. A source write invalidates, even if it wrote the
// same value. Status/usage/receipt-only writes do not change the history's interpretation.
export const HISTORY_PROJECTION_INVALIDATE = `CREATE TRIGGER IF NOT EXISTS run_history_projection_invalidate
AFTER UPDATE OF history_json, resumes_run_id ON runs BEGIN
  DELETE FROM run_history_projection WHERE run_id=NEW.id;
END`
export const HISTORY_PROJECTION_DELETE = `CREATE TRIGGER IF NOT EXISTS run_history_projection_delete
AFTER DELETE ON runs BEGIN
  DELETE FROM run_history_projection WHERE run_id=OLD.id;
END`

function parse(raw: string | null): unknown {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return null }
}
export function continuationLength(raw: string | null, messages = parse(raw)): number | null {
  if (!raw || raw === '[]') return null
  if (!isModelMessages(messages)) return 0
  const at = lastCompactionIndex(messages)
  const view = at <= 0 ? messages : messages.slice(at)
  return messages.length + (danglingToolCalls(view).length ? 1 : 0)
}

export function projectedCount(conn: Conn, id: string): { count: number | null } | null {
  const row = conn.get('SELECT p.continuation_count FROM run_history_projection p JOIN runs r ON r.id=p.run_id WHERE p.run_id=?', [id])
  return row ? { count: row.continuation_count === null ? null : Number(row.continuation_count) } : null
}
export function projectedOwnHistory(conn: Conn, id: string, inherited: number): { messages: unknown; offset: number } | null {
  const row = conn.get('SELECT p.message_count, p.own_offset, p.own_json FROM run_history_projection p JOIN runs r ON r.id=p.run_id WHERE p.run_id=?', [id])
  if (!row || typeof row.own_json !== 'string') return null
  const offset = inherited > 0 && inherited <= Number(row.message_count) ? inherited : 0
  // Parent records can be edited/deleted long after a child finished. Validate the CURRENT boundary, including
  // empty ancestor chains, rather than treating child id/status/saved_seq as a permanent version.
  if (offset !== Number(row.own_offset)) return null
  try { return { messages: JSON.parse(row.own_json), offset } } catch { return null }
}

/** Read just the count along the same empty-parent chain as the runner. During migration counts are memoized
 * only inside that write transaction; there is no cross-connection or cross-revision cache here. */
function inheritedCount(conn: Conn, parent: string | null, counts: Map<string, number | null>): number {
  const walked = new Set<string>()
  while (parent !== null && !walked.has(parent)) {
    walked.add(parent)
    let count = counts.get(parent)
    if (count === undefined) {
      const projected = projectedCount(conn, parent)
      if (projected) count = projected.count
      else {
        const row = conn.get('SELECT history_json FROM runs WHERE id=?', [parent])
        count = continuationLength(row?.history_json == null ? null : String(row.history_json))
      }
      counts.set(parent, count)
    }
    if (count !== null) return count
    const row = conn.get('SELECT resumes_run_id FROM runs WHERE id=?', [parent])
    parent = row?.resumes_run_id == null ? null : String(row.resumes_run_id)
  }
  return 0
}

function project(conn: Conn, id: string, counts: Map<string, number | null>): void {
  const row = conn.get('SELECT history_json, resumes_run_id FROM runs WHERE id=?', [id])
  if (!row) return
  const raw = row.history_json == null ? null : String(row.history_json), messages = parse(raw)
  const count = continuationLength(raw, messages)
  counts.set(id, count)
  const inherited = inheritedCount(conn, row.resumes_run_id == null ? null : String(row.resumes_run_id), counts)
  const length = Array.isArray(messages) ? messages.length : -1
  const offset = inherited > 0 && inherited <= length ? inherited : 0
  const own = Array.isArray(messages) ? messages.slice(offset) : messages
  let ownJson: string | null = JSON.stringify(own)
  // This is a retention bound, NOT a content limit: huge/non-roundtrippable values use the raw reader. JSON.parse
  // accepts e.g. 1e999 and -0; JSON.stringify changes them, so never persist a lossy reinterpretation of the source.
  if (ownJson.length * 2 > 8 * 1024 * 1024 || !isDeepStrictEqual(own, JSON.parse(ownJson))) ownJson = null
  conn.run('INSERT OR REPLACE INTO run_history_projection(run_id, continuation_count, message_count, own_offset, own_json) VALUES(?,?,?,?,?)', [id, count, length, offset, ownJson])
}

/** Called after a run finishes, never on each streaming progress save. Read source + publish derived row in one
 * transaction so a second connection cannot install stale bytes after the invalidation trigger has run. */
export function writeHistoryProjection(conn: Conn, id: string): void {
  conn.transaction(() => project(conn, id, new Map()))
}

/** One-time migration cost is intentionally explicit; the schema upgrader already holds the write transaction.
 * Only ids/counts stay in memory. Histories are read one at a time, never a SELECT of every raw history at once. */
export function backfillHistoryProjections(conn: Conn): void {
  const ids = conn.all('SELECT id FROM runs ORDER BY created_at, rowid')
  const counts = new Map<string, number | null>()
  for (const row of ids) project(conn, String(row.id), counts)
}
