import type { SSEItem } from './types'
import { ACTIVE_DIRECTOR_TURN_STATUSES, ACTIVE_RUN_STATUSES, DIRECTOR_TURN_EVENTS } from '@oasis-code/contract'
import { api, directorTurnEventsUrl, eventSourceUrl, sessionEventsUrl } from './client'
import { createRunStream, type ConnectionState } from './runStream'
import { createSessionStream, type SessionStream } from './sessionStream'
import { runConnections } from '../state/runConnections'

/** The open session's one stream (sessionStream.ts): every run followed while it is open shares its connection. */
let session: { stream: SessionStream; cleanup: () => void } | null = null

/** Follow every run of the session on one connection, from the session cursor a session detail named; any stream
 *  open for another session is closed. `onNewRun`: a run of the session the stream heard first. */
export function openSessionStream(sessionId: string, cursor: number, onNewRun?: (runId: string) => void): void {
  closeSessionStream()
  const stream = createSessionStream({
    sessionId, cursor, names: KNOWN_EVENTS, onNewRun,
    source: (after) => new EventSource(sessionEventsUrl(sessionId, after), { withCredentials: true }),
    run: (runId) => api.run(runId),
    history: (runId, after, limit) => api.runEventsPage(runId, after, limit),
    fallback: runStream,
  })
  const online = () => stream.reconnect()
  const visible = () => { if (document.visibilityState === 'visible') stream.reconnect() }
  window.addEventListener('online', online)
  document.addEventListener('visibilitychange', visible)
  session = { stream, cleanup: () => { window.removeEventListener('online', online); document.removeEventListener('visibilitychange', visible) } }
}

export function closeSessionStream(): void {
  if (!session) return
  const { stream, cleanup } = session
  session = null
  cleanup()
  stream.close()
}

/** A run's events after `after`: through the open session's stream (a run of another session, or with no session
 *  stream open — an older harness — from the run's own stream).
 *  Reconnect subscriptions, not runs. Unknown named events must be added to KNOWN_EVENTS explicitly. */
export function subscribeRunEvents(
  runId: string,
  onEvent: (item: SSEItem) => void,
  onClose: () => void,
  after: number | null = null,
  onConnection?: (state: ConnectionState) => void,
): () => void {
  if (!session) return runStream(runId, after, onEvent, onClose, onConnection)
  const owner = Symbol(runId)
  return session.stream.follow(runId, after, onEvent, onClose, (state) => { runConnections.set(runId, owner, state); onConnection?.(state) })
}

/** The run's own stream (GET /api/runs/:id/events): one connection for the one run. */
function runStream(
  runId: string,
  after: number | null,
  onEvent: (item: SSEItem) => void,
  onClose: () => void,
  onConnection?: (state: ConnectionState) => void,
): () => void {
  const owner = Symbol(runId)
  let stream: ReturnType<typeof createRunStream> | null = null
  const online = () => stream?.reconnect()
  const visible = () => { if (document.visibilityState === 'visible') stream?.reconnect() }
  const cleanup = () => {
    window.removeEventListener('online', online)
    document.removeEventListener('visibilitychange', visible)
  }
  window.addEventListener('online', online)
  document.addEventListener('visibilitychange', visible)
  stream = createRunStream({
    names: KNOWN_EVENTS, after,
    source: (cursor) => new EventSource(eventSourceUrl(runId, cursor), { withCredentials: true }),
    event: onEvent, finished: () => { cleanup(); onClose() },
    settled: async () => !ACTIVE_RUN_STATUSES.includes((await api.run(runId)).status),
    connection: (state) => { runConnections.set(runId, owner, state); onConnection?.(state) },
  })
  return () => { cleanup(); stream?.close() }
}
export const KNOWN_EVENTS = [
  'run_started', 'text_delta', 'text_block', 'thinking_delta', 'thinking_block', 'tool_call', 'tool_result',
  'execution_started', 'checkpoint', 'action_gated', 'budget_closing', 'slot_wait', 'slot_acquired', 'run_continued',
  'context_compacting', 'context_compacted', 'model_request', 'error', 'run_finished', 'run_queued', 'lock_violation', 'integration',
  'tool_call_progress',
  'ui_surface', 'ui_task', 'ui_input',
  // in-run steering: words sent while the run worked, queued, then delivered into a request or not (data { steer })
  'steer_queued', 'steer_delivered', 'steer_undelivered',
  // an attached file the run's tools cannot reach (a command's grant refused, a legacy placement refused)
  'attachment_refused',
] as const

/** A director turn as it streams: its text, the tools it calls, its end; reconnects like a run's stream. */
export function subscribeDirectorTurn(turnId: string, onEvent: (item: SSEItem) => void, onClose: () => void, after: number | null = null): () => void {
  let stream: ReturnType<typeof createRunStream> | null = null
  const online = () => stream?.reconnect()
  const visible = () => { if (document.visibilityState === 'visible') stream?.reconnect() }
  const cleanup = () => {
    window.removeEventListener('online', online)
    document.removeEventListener('visibilitychange', visible)
  }
  window.addEventListener('online', online)
  document.addEventListener('visibilitychange', visible)
  stream = createRunStream({
    names: DIRECTOR_TURN_EVENTS, after, endEvent: 'turn_finished',
    source: (cursor) => new EventSource(directorTurnEventsUrl(turnId, cursor), { withCredentials: true }),
    event: onEvent, finished: () => { cleanup(); onClose() },
    settled: async () => !ACTIVE_DIRECTOR_TURN_STATUSES.includes((await api.directorTurn(turnId)).status),
  })
  return () => { cleanup(); stream?.close() }
}
