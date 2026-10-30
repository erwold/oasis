/** The journal of a folder edited in place (a direct project, schema v19): every write a file tool makes there is kept
 *  first — the file as it was, then as it was written — so a run's file changes can be told exactly and undone. A
 *  command's writes are not in it: what a command changes is its own, as in any shell. */

import { z } from 'zod'

export const JOURNAL_ACTIONS = ['created', 'edited', 'overwritten', 'restored', 'removed'] as const
export const JOURNAL_STATES = ['prepared', 'applied', 'abandoned', 'unsettled'] as const

export const JournalEntrySchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  session_id: z.string().nullable(),
  /** the run whose tool wrote it (null: an undo) */
  run_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  /** relative to the folder */
  path: z.string(),
  action: z.enum(JOURNAL_ACTIONS),
  /** prepared: kept before the write; applied: written; abandoned: the write did not happen; unsettled: the harness
   *  stopped during the write and the file is found neither as it was kept nor as the write meant to leave it (another
   *  hand changed it meanwhile) — not the run's change, and never undone */
  state: z.enum(JOURNAL_STATES),
  before_exists: z.boolean(),
  before_sha: z.string().nullable(),
  after_sha: z.string().nullable(),
  /** what the write meant to leave (null: a removal, or an entry kept before this was recorded) */
  intended_sha: z.string().nullable(),
  /** the undo that took this write back */
  undone_by: z.string().nullable(),
  created_at: z.string(),
})
export type JournalEntry = z.infer<typeof JournalEntrySchema>

/** Why a file was left alone by an undo, as a code beside the words: changed (or removed) since the run wrote it,
 *  chain_broken (the file changed between two of the run's own writes: the whole path is not the run's to put back),
 *  unsettled / unreadable (the harness cannot tell what its write left), remote_unknown (a remote write's outcome is
 *  not known). Absent on an older answer. */
export const UNDO_CONFLICT_CODES = ['changed_since', 'removed_since', 'chain_broken', 'unsettled', 'unreadable', 'remote_unknown'] as const
export const UndoConflictCodeSchema = z.enum(UNDO_CONFLICT_CODES)
export type UndoConflictCode = z.infer<typeof UndoConflictCodeSchema>

/** What undoing a run's file changes did: each file put back as it was before the run (or removed, when the run
 *  created it), or left alone because it changed since the run wrote it (the person's edit, a later run's). */
export const UndoResultSchema = z.object({
  run_id: z.string(),
  restored: z.array(z.string()),
  removed: z.array(z.string()),
  conflicts: z.array(z.object({ path: z.string(), reason: z.string(), code: UndoConflictCodeSchema.optional() })),
  /** nothing to undo: the run wrote no file with a tool, or its writes were undone already */
  nothing: z.boolean(),
})
export type UndoResult = z.infer<typeof UndoResultSchema>
