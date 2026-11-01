/** One reader for the individual record and the complete session-opening envelope. No response cache: status,
 * steers, forms, surfaces and compactions are read now; the history reader owns its bounded DB-revision cache. */
import { ACTIVE_RUN_STATUSES } from '@oasis-code/contract'
import { rebuildStoredTranscript } from '../agent/transcript.ts'
import * as repo from '../db/repo.ts'
import { HttpError } from './common.ts'
import type { AppState } from './state.ts'

export function storedTranscript(state: AppState, runId: string) {
  const run = repo.getTranscriptRun(state.conn, runId)
  if (run === null) throw new HttpError(404, `run not found: ${runId}`)
  const ended = ACTIVE_RUN_STATUSES.includes(run.status) ? null : run.status
  const steers = state.runs.steersOf(runId)
  const entries = rebuildStoredTranscript(state.conn, run, ended, repo.listUiSurfaces(state.conn, run.session_id, runId),
    repo.listUiInputs(state.conn, run.session_id, { run_id: runId, limit: 1_000 }), steers, repo.listCompactionEvents(state.conn, runId))
  return { run_id: runId, status: run.status, model: run.model, entries, steers }
}
