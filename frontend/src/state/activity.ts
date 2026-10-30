/** Activity rows: one per (run, tool_call_id), whichever of the call and
 * the result arrives first; a replayed event adds nothing. Adapted from
 * oasis frontend/src/state/activity.ts. */

export interface Correlated {
  runId?: string
  toolCallId?: string
  eventId?: string
  running?: boolean
}

export function startActivity<T extends Correlated>(thread: T[], entry: T): T[] {
  if (entry.toolCallId && thread.some((e) => e.runId === entry.runId && e.toolCallId === entry.toolCallId)) return thread
  return [...thread, entry]
}

export function completeActivity<T extends Correlated>(
  thread: T[],
  key: { runId?: string; toolCallId?: string },
  sameShape: (entry: T) => boolean,
  complete: (start: T | undefined) => T,
): T[] {
  const index = key.toolCallId
    ? thread.findIndex((e) => e.runId === key.runId && e.toolCallId === key.toolCallId)
    : thread.findIndex((e) => e.runId === key.runId && e.running === true && !e.toolCallId && sameShape(e))
  const start = index >= 0 ? thread[index] : undefined
  const built = complete(start)
  const done: T = { ...built, running: false, runId: key.runId, toolCallId: key.toolCallId || built.toolCallId }
  if (index < 0) return [...thread, done]
  const next = [...thread]
  next[index] = done
  return next
}

/** An event id already in the thread is a replay: nothing is added. */
export function pushOnce<T extends Correlated>(thread: T[], entry: T): T[] {
  if (entry.eventId && thread.some((e) => e.eventId === entry.eventId && e.runId === entry.runId)) return thread
  return [...thread, entry]
}
