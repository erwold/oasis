/** The folder's lock as the API answers it: a refusal (409 workspace_busy, who holds the folder, since when, how to
 *  go on) and the harness's own operations on a folder run as its one writer (workspace/locks.ts). */

import { newId } from '../ids.ts'
import { WorkspaceBusy, type LockHolderView } from '../workspace/locks.ts'
import { HttpError } from './state.ts'
import type { AppState } from './state.ts'

/** A refusal of the folder's lock: 409, code workspace_busy, its detail's fields beside the words (and `extra`). */
export function busyHttp(busy: WorkspaceBusy, extra: Record<string, unknown> | null = null): HttpError {
  return new HttpError(409, busy.message, busy.code, { ...busy.detail, ...(extra ?? {}) })
}

/** Run an operation of the harness on the folder as its one writer: the folder is taken — or the operation refused
 *  (409 workspace_busy, naming who holds it) — in the same step as the check, and let go when the operation is done,
 *  so nobody starts writing between the check and the operation. Never waits: a person's or a director's request is
 *  answered at once. */
export async function underFolderLock<T>(state: Pick<AppState, 'locks'>, workspaceId: string, operation: string, fn: () => Promise<T>,
  nextStep?: ((h: LockHolderView) => string) | null, extra: Record<string, unknown> | null = null): Promise<T> {
  const owner = `operation:${operation}:${newId('op')}`
  try {
    state.locks.acquireNow(workspaceId, owner, { kind: 'operation', operation }, nextStep)
  } catch (error) {
    if (error instanceof WorkspaceBusy) throw busyHttp(error, extra)
    throw error
  }
  try {
    return await fn()
  } finally {
    state.locks.release(workspaceId, owner)
  }
}
