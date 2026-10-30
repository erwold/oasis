/** How the page keeps the session's collaboration graph (pure, so node --test exercises it): read when the session
 *  opens; read again (with `?if_revision=`, a 304 when nothing moved) when the session's detail names another
 *  revision, when a run's stream says one ended or continued, and on the sync tick while a read failed. An older
 *  harness without the route (404, 405, 501) is no error: the page projects the graph from the rows it holds
 *  (state/collab.ts legacyGraph), silently. Any other failure keeps the graph the page had, says so once (not on every
 *  retry) and asks again on the next tick. An answer for a session no longer open, or older than a later request's,
 *  is dropped (a ticket). */

import type { CollaborationGraph } from '@oasis-code/contract'

export type CollabStatus = 'idle' | 'loading' | 'graph' | 'legacy' | 'error'

export interface CollabState {
  sessionId: string | null
  status: CollabStatus
  graph: CollaborationGraph | null
  revision: string | null
  /** the last failure, in the harness's words; null once a read succeeded */
  error: string | null
  /** the failure was said (a toast) already: a retry that fails the same way says nothing more */
  told: boolean
}

export const EMPTY_COLLAB: CollabState = { sessionId: null, status: 'idle', graph: null, revision: null, error: null, told: false }

/** What one read answered. */
export type CollabAnswer =
  | { kind: 'graph'; graph: CollaborationGraph }
  | { kind: 'unchanged' }
  | { kind: 'absent' }                         // an older harness: no such route
  | { kind: 'failed'; message: string; status: number | null }

/** The statuses that mean the route is not there (an older harness), not that it failed. */
export const ABSENT_STATUSES = new Set([404, 405, 501])

export function answerOf(result: { ok: true; value: CollaborationGraph | { unchanged: true } } | { ok: false; status: number | null; message: string }): CollabAnswer {
  if (result.ok) return 'unchanged' in result.value ? { kind: 'unchanged' } : { kind: 'graph', graph: result.value }
  if (result.status !== null && ABSENT_STATUSES.has(result.status)) return { kind: 'absent' }
  return { kind: 'failed', message: result.message, status: result.status }
}

/** The state after an answer for `sessionId` (an answer for another session changes nothing), and whether the
 *  failure is to be said now (once per run of failures). */
export function reduceCollab(state: CollabState, sessionId: string, answer: CollabAnswer): { state: CollabState; tell: string | null } {
  if (state.sessionId !== sessionId) return { state, tell: null }
  switch (answer.kind) {
    case 'graph':
      return { state: { ...state, status: 'graph', graph: answer.graph, revision: answer.graph.revision, error: null, told: false }, tell: null }
    case 'unchanged':
      return { state: { ...state, status: state.graph ? 'graph' : state.status, error: null, told: false }, tell: null }
    case 'absent':
      // an older harness: the page's own projection stands in; no graph is held, nothing is said
      return { state: { ...state, status: 'legacy', graph: null, revision: null, error: null, told: false }, tell: null }
    case 'failed': {
      // the graph the page had stays (a failed read clears nothing on show); a harness's refusal is said once (a
      // network failure is the connection's to say: the page's reconnecting state shows it)
      const tell = state.told || answer.status === null ? null : `Could not read the session's relations (${answer.status}): ${answer.message}. Retrying.`
      return { state: { ...state, status: state.graph ? 'graph' : 'error', error: answer.message, told: state.told || tell !== null }, tell }
    }
  }
}

/** A fresh state for a session the page opens (the previous session's graph never shows under another). */
export function openCollab(sessionId: string): CollabState {
  return { ...EMPTY_COLLAB, sessionId, status: 'loading' }
}

/** Whether a sync tick reads the graph again: the detail names a revision the page does not hold; or a read failed
 *  and is retried; or the detail says nothing of revisions (an answer of a harness that has the route but not the
 *  field) while something moved. An older harness (legacy) is not asked again until the session is opened again. */
export function wantsReload(state: CollabState, detailRevision: string | null | undefined, moved: boolean): boolean {
  if (state.sessionId === null || state.status === 'legacy' || state.status === 'loading') return false
  if (state.error !== null) return true
  if (detailRevision !== undefined && detailRevision !== null) return detailRevision !== state.revision
  return moved
}
