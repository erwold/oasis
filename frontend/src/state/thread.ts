/** The thread reducer: how run events (live or replayed) become rows.
 * Pure, so node --test exercises it without a browser. Every event kind
 * has a row; an unknown one gets the generic row rather than silence. */

import type { SSEItem, TranscriptEntry } from '../api/types'
import { completeActivity, pushOnce, startActivity, type Correlated } from './activity.ts'
import { isSurfaceRecord, sameWord, sessionEventRefusal, supersedes, surfaceEventRole, surfaceKey, type RunFacts, type SessionFacts, type UiSurfaceRecord } from './uiSurface.ts'
import { isInputRecord, upsertInput, type UiInputRecord } from './uiInputs.ts'
import { UiTaskRecordSchema, type UiTaskRecord } from '@oasis-code/contract'
import { applySteer, isSteerRecord, steerRowFor, type SteerRecord } from './steer.ts'
import { waitingLine, waitingOf } from './outline.ts'

/** `ui`: a surface the agent presented (present_ui) — its own block in the answer, never folded into the work;
 *  `input`: a form the run waits on (request_input) — its own block too, answered in place */
export type EntryKind = 'user' | 'agent' | 'thinking' | 'activity' | 'note' | 'error' | 'gate' | 'system' | 'ui' | 'input'

export interface ThreadEntry extends Correlated {
  kind: EntryKind
  text?: string
  tool?: string
  summary?: string
  args?: Record<string, unknown> | null
  result?: Record<string, unknown>
  detail?: Record<string, unknown>
  status?: string
  model?: string
  eventName?: string
  /** an answer a broken stream cut off, kept by the harness: the rest joins this row instead of opening another */
  continues?: boolean
  /** the kept words the rest of the answer follows (a closing block carries only the rest) */
  prefix?: string
  /** a tool call the model is still writing: its arguments so far, in characters (the call's own row replaces it) */
  forming?: { id: string; chars: number }
  /** a `ui` row's surface as the harness last said it (a replay: as it stood at the moment) */
  surface?: UiSurfaceRecord
  /** an `input` row's request as the harness last said it */
  input?: UiInputRecord
  /** a `ui_task` line's task (the run is that task's: started from a surface) */
  task?: UiTaskRecord
  /** a `user` row's steer: words the person sent while the run worked, as the harness last said them (state/steer.ts) */
  steer?: SteerRecord
}

function str(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v) }

/** Text deltas extend the streaming agent (or thinking) row of the
 * same run; a start flag or a block opens / closes it. */
function appendText(thread: ThreadEntry[], runId: string, kind: 'agent' | 'thinking', text: string, start: boolean): ThreadEntry[] {
  const cut = kind === 'agent' ? [...thread.keys()].reverse().find((k) => thread[k].kind === 'agent' && thread[k].runId === runId && thread[k].continues) : undefined
  if (cut !== undefined) {
    const next = [...thread]
    next[cut] = { ...next[cut], text: (next[cut].text ?? '') + text, running: true, continues: false }
    return next
  }
  // the block still streaming goes on in its row, whatever came below it meanwhile: words the person sent while the
  // run worked, or the note that said the connection dropped (a continued answer)
  const streaming = start ? undefined : [...thread.keys()].reverse().find((k) => thread[k].kind === kind && thread[k].runId === runId && thread[k].running)
  if (streaming !== undefined) {
    const next = [...thread]
    next[streaming] = { ...next[streaming], text: (next[streaming].text ?? '') + text }
    return next
  }
  // an answer part that opens empty (Antigravity and Gemini send empty text parts beside their signatures) takes no
  // row until it has words: an empty row would still draw the speaker's name
  if (kind === 'agent' && !text) return thread
  return [...thread, { kind, runId, text, running: true }]
}

function closeText(thread: ThreadEntry[], runId: string, kind: 'agent' | 'thinking', text: string): ThreadEntry[] {
  // the streaming row, or — when the rest of a kept answer arrives as its block alone (a saved run replayed: the
  // deltas are not kept) — the row that waits for it
  const i = [...thread.keys()].reverse().find((k) => thread[k].kind === kind && thread[k].runId === runId && thread[k].running)
    ?? (kind === 'agent' ? [...thread.keys()].reverse().find((k) => thread[k].kind === 'agent' && thread[k].runId === runId && thread[k].continues) : undefined)
  if (i == null) return text ? [...thread, { kind, runId, text, running: false }] : thread
  const next = [...thread]
  next[i] = settled({ ...next[i], text: text ? (next[i].prefix ?? '') + text : next[i].text })
  if (kind === 'agent' && !next[i].text) next.splice(i, 1)
  return next
}

/** A row no longer streaming nor waiting for the rest of its answer. */
function settled(entry: ThreadEntry): ThreadEntry {
  const next: ThreadEntry = { ...entry, running: false }
  delete next.continues
  delete next.prefix
  return next
}

/** Words the harness kept for their rest — a broken stream's (its answer row still streaming) or an answer cut at the
 *  output limit (its row already closed): that row waits for the rest. */
function keepCut(thread: ThreadEntry[], runId: string, closed: boolean): ThreadEntry[] {
  const i = [...thread.keys()].reverse().find((k) => thread[k].kind === 'agent' && thread[k].runId === runId && (thread[k].running || closed))
  if (i === undefined) return thread
  const next = [...thread]
  next[i] = { ...next[i], running: false, continues: true, prefix: next[i].text ?? '' }
  return next
}

/** A run's rows without its calls still forming: their call came, or the run is over. */
function withoutForming(thread: ThreadEntry[], runId: string): ThreadEntry[] {
  return thread.some((e) => e.runId === runId && e.forming) ? thread.filter((e) => !(e.runId === runId && e.forming)) : thread
}

/** A steer word (steer_queued / steer_delivered / steer_undelivered: data { steer }): the steer's one row, placed
 *  where that word came (state/steer.ts); a record the page cannot read is said as such, never shown as words. */
const steerRow = (thread: ThreadEntry[], runId: string, d: Record<string, unknown>, item: SSEItem, eventId: string | undefined): ThreadEntry[] => {
  const record = d.steer
  if (!isSteerRecord(record) || record.run_id !== runId) {
    return pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: 'Words sent while the run worked arrived in a form the page could not read', detail: d })
  }
  return applySteer(thread, runId, record, eventId)
}

/** How each event becomes rows: a registry keyed by event name (adding an event means adding a row here, not a
 *  branch elsewhere); an event nobody registered still gets the generic row, never silence. */
type Handler = (thread: ThreadEntry[], runId: string, d: Record<string, unknown>, item: SSEItem, eventId: string | undefined) => ThreadEntry[]

export const EVENT_ROWS: Record<string, Handler> = {
  run_started: (thread, runId, d, item, eventId) => {
      const started = pushOnce(thread, { kind: 'system', runId, eventId, eventName: item.event, model: str(d.model),
        text: `Run started on ${str(d.model)}${d.resumes_run_id ? ' (continuing the session)' : ''}${d.handoff ? ' — handoff from another provider' : ''}`, detail: d })
      // an earlier run's command still running in the same folder may write what this run reads and writes
      const running = Array.isArray(d.running_commands) ? d.running_commands as Record<string, unknown>[] : []
      if (!running.length) return started
      return pushOnce(started, { kind: 'note', runId, eventId: eventId ? `${eventId}:running` : undefined, eventName: item.event,
        text: `Still running in this folder from an earlier run: ${running.map((x) => `${str(x.command)} (${str(x.execution_id)})`).join('; ')} — it may change files while this run works`, detail: d })
    },
  text_delta: (thread, runId, d) =>
    appendText(thread, runId, 'agent', str(d.text), d.start === true),
  text_block: (thread, runId, d) =>
    closeText(thread, runId, 'agent', str(d.text)),
  thinking_delta: (thread, runId, d) =>
    appendText(thread, runId, 'thinking', str(d.text), d.start === true),
  thinking_block: (thread, runId, d) =>
    closeText(thread, runId, 'thinking', str(d.text)),
  tool_call_progress: (thread, runId, d) => {
      const forming = { id: str(d.tool_call_id), chars: Number(d.chars) || 0 }
      const i = thread.findIndex((e) => e.runId === runId && e.forming?.id === forming.id)
      if (i < 0) return [...thread, { kind: 'activity', runId, tool: str(d.tool), args: d, running: true, forming }]
      const next = [...thread]
      next[i] = { ...next[i], args: d, forming }
      return next
    },
  tool_call: (thread, runId, d, item) =>
    startActivity(withoutForming(thread, runId), { kind: 'activity', runId, eventId: item.id, toolCallId: str(d.tool_call_id), tool: str(d.tool),
        summary: str(d.summary), args: d, running: true }),
  tool_result: (thread, runId, d) => {
      const key = { runId, toolCallId: str(d.tool_call_id) || undefined }
      return completeActivity(withoutForming(thread, runId), key, (e) => e.kind === 'activity' && e.tool === str(d.tool),
        (start) => ({ ...(start ?? { kind: 'activity', tool: str(d.tool) }), result: d, status: str(d.status) || 'ok', running: false }))
    
  },
  execution_started: (thread, runId, d) => {
      const key = { runId, toolCallId: str(d.tool_call_id) || undefined }
      const i = thread.findIndex((e) => e.runId === runId && e.toolCallId === key.toolCallId)
      if (i < 0) return thread
      const next = [...thread]
      // where it actually runs (requested / effective access, the reasons, the restrictions), when the harness says it
      const access = Object.fromEntries(['requested_access', 'effective_access', 'access_reasons', 'restrictions'].filter((k) => d[k] !== undefined).map((k) => [k, d[k]]))
      next[i] = { ...next[i], detail: { ...(next[i].detail ?? {}), execution_id: d.execution_id, command: d.command, ...access } }
      return next
    
  },
  checkpoint: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: `Checkpoint ${str(d.checkpoint_id)} · ${str(d.changed)} file(s) · ${str(d.note)}`, detail: d }),
  action_gated: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'gate', runId, eventId, eventName: item.event, text: `Needs approval: ${str(d.action)} — ${str(d.reason)}`, detail: d }),
  budget_closing: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: `Budget reached (${str(d.reason)}): closing turn, report only`, detail: d }),
  slot_wait: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: `Waiting for a request slot on ${str(d.scope)} (behind ${(Array.isArray(d.behind) ? d.behind.length : 0)} run(s))`, detail: d }),
  slot_acquired: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: str(d.scope).startsWith('workspace:') ? `Workspace ${str(d.scope).slice('workspace:'.length)} free · started` : `Slot acquired on ${str(d.scope)}`, detail: d }),
  run_continued: (thread, runId, d, item, eventId) =>
    pushOnce(Number(d.kept_chars) > 0 ? keepCut(thread, runId, d.reason === 'output_limit') : thread, { kind: 'note', runId, eventId, eventName: item.event, text: continuationLine(d), detail: d }),
  integration: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event,
        text: `Integration ${str(d.status)}: ${Array.isArray(d.applied) ? d.applied.length : 0} checkpoint(s) applied${Array.isArray(d.conflicts) && d.conflicts.length ? `, conflicts in ${d.conflicts.join(', ')}` : ''}${d.applied_to_workspace ? ', written to the workspace' : d.reason ? ` — ${str(d.reason)}` : ''}`, detail: d }),
  context_compacted: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: compactionNote(d), detail: d }),
  lock_violation: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'error', runId, eventId, eventName: item.event,
      text: `Locked content changed by a command: ${(Array.isArray(d.violations) ? d.violations : []).map(String).join('; ')}`, detail: d }),
  attachment_refused: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'error', runId, eventId, eventName: item.event,
      text: `Attached file not available to the agent's ${d.scope === 'placement' ? 'tools' : 'commands'}${d.name ? ` (${str(d.name)})` : d.asset_id ? ` (${str(d.asset_id)})` : ''}: ${str(d.reason)}`, detail: d }),
  // waiting for what holds the run's folder (a run, a command, an approval): named; ChatGPT's own queue says its reason
  run_queued: (thread, runId, d, item, eventId) => {
    const waiting = waitingOf(d)
    return pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: waiting ? waitingLine(waiting) : `Queued${d.reason ? `: ${str(d.reason)}` : ' behind another run'}`, detail: d })
  },
  // a surface is one row per surface id of the run, where it was first presented: a later revision (or its state
  // saved) replaces the record in place; an older or repeated word changes nothing. A session surface this run
  // updated stays where an earlier run of the thread presented it: that row is updated (crossSurfaceOf, by whoever
  // holds the rows of both runs), this run gets no second copy
  ui_surface: (thread, runId, d, item, eventId) => {
    const record = d.surface
    const role = surfaceEventRole(runId, record)
    if (role === 'cross') return thread
    if (role === null) {
      return pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: 'A UI surface arrived that the page could not read', detail: d })
    }
    return upsertSurface(thread, runId, record as UiSurfaceRecord, eventId)
  },
  // a form the run waits on: one row per input id, where the run asked for it, updated in place (answered, closed)
  ui_input: (thread, runId, d, item, eventId) => {
    const record = d.input
    if (!isInputRecord(record) || record.run_id !== runId) {
      return pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: 'A form arrived that the page could not read', detail: d })
    }
    return upsertInput(thread, runId, record, eventId)
  },
  // the run is a UI task's: one line, its status as the task's record last said it (a later record replaces it)
  ui_task: (thread, runId, d, item, eventId) => {
    const parsed = UiTaskRecordSchema.safeParse(d.task)
    if (!parsed.success) return pushOnce(thread, { kind: 'note', runId, eventId, eventName: item.event, text: 'A UI task update arrived that the page could not read', detail: d })
    const task = parsed.data
    const line: ThreadEntry = { kind: 'note', runId, eventId, eventName: 'ui_task', task, text: taskLine(task) }
    const at = thread.findIndex((e) => e.eventName === 'ui_task' && e.runId === runId && e.task?.id === task.id)
    if (at < 0) return [...thread, line]
    if (!(task.updated_at > (thread[at]!.task?.updated_at ?? ''))) return thread
    const next = [...thread]
    next[at] = { ...line, eventId: thread[at]!.eventId }
    return next
  },
  // words the person sent while the run worked: queued at the run's tail, then where they went into a request (or not)
  steer_queued: steerRow,
  steer_delivered: steerRow,
  steer_undelivered: steerRow,
  // footers read the run's records; a row per request would be noise
  model_request: (thread) => thread,
  error: (thread, runId, d, item, eventId) =>
    pushOnce(thread, { kind: 'error', runId, eventId, eventName: item.event, text: `${str(d.kind) || 'error'}: ${str(d.message)}`, detail: d }),
  run_finished: (thread, runId, d, item, eventId) => {
      const status = str(d.status)
      // the run is over: nothing of it streams, and no answer of it waits for a rest that can no longer come
      const closed = withoutForming(thread, runId).map((e) => (e.runId === runId && (e.running || e.continues) ? settled(e) : e))
      // a run done with an answer the provider stopped (its filter, a refusal) is said as such, not as an answer that
      // ended as asked (older events carry the end in the receipt only)
      const receipt = d.receipt as { mechanical?: { answer_end?: unknown } } | undefined
      const end = (d.answer_end ?? receipt?.mechanical?.answer_end) as { reason?: unknown } | null | undefined
      const note = status === 'done'
        ? (end?.reason === 'content_filter' ? 'The provider stopped the answer (a refusal or its content filter): the words above are all it gave' : null)
        : `Run ${status}${d.error ? `: ${str(d.error)}` : ''}`
      return note ? pushOnce(closed, { kind: status === 'error' ? 'error' : 'note', runId, eventId, eventName: item.event, text: note, detail: d }) : closed
    
  },
}

/** The run's thread with `record` in it: its surface's row updated in place when the record is the later word, else
 *  as it was; a surface not yet in the thread joins at its end. */
export function upsertSurface(thread: ThreadEntry[], runId: string, record: UiSurfaceRecord, eventId?: string): ThreadEntry[] {
  const at = thread.findIndex((e) => e.kind === 'ui' && e.runId === runId && e.surface?.surface_id === record.surface_id)
  if (at < 0) return [...thread, { kind: 'ui', runId, eventId, eventName: 'ui_surface', surface: record }]
  const current = thread[at].surface
  if (!supersedes(record, current) || (current && sameWord(record, current))) return thread
  const next = [...thread]
  next[at] = { ...next[at], surface: record }
  return next
}

/** Threads (by run) with the session's surfaces the harness listed: each into its run's thread when that run is on
 *  the page and `into` takes it (a live run's rows are its stream's); a thread no record changed stays the same object. */
export function withSurfaces(threads: Record<string, ThreadEntry[]>, records: UiSurfaceRecord[], into: (runId: string) => boolean = () => true): Record<string, ThreadEntry[]> {
  let out = threads
  for (const record of records) {
    if (!isSurfaceRecord(record) || !(record.run_id in threads) || !into(record.run_id)) continue
    const before = out[record.run_id]!
    const after = upsertSurface(before, record.run_id, record)
    if (after !== before) out = { ...out, [record.run_id]: after }
  }
  return out
}

/** A run's rows after a surface event with the later state the session's list already brought (a stream read again
 *  from its start after a refresh replays the surface as presented; the state saved since is the list's). */
export function withKnownSurfaces(rows: ThreadEntry[], runId: string, item: SSEItem, known: Record<string, UiSurfaceRecord>): ThreadEntry[] {
  const surface = item.data.surface
  if (item.event !== 'ui_surface' || !isSurfaceRecord(surface)) return rows
  // only this event's surface: one the stream has not reached yet joins where the stream presents it
  const later = known[surfaceKey(surface)]
  return later && later.run_id === runId ? (withSurfaces({ [runId]: rows }, [later])[runId] ?? rows) : rows
}

/** Where the page holds a session's surfaces: the records as the harness last said them (by surfaceKey), the thread's
 *  rows and the rows of the runs beside it (by run), and which runs a stream here places rows for. */
export interface SurfaceHolders {
  uiSurfaces: Record<string, UiSurfaceRecord>
  threads: Record<string, ThreadEntry[]>
  childThreads: Record<string, ThreadEntry[]>
  streamed: Record<string, unknown>
  childStreamed: Record<string, unknown>
}

/** What adopting `record` changes (null: nothing — not the later word on its surface). It goes into the rows of its
 *  run (run_id — for a session surface the anchor, whichever run wrote it) in place; a run streamed here places its
 *  own new surfaces where it presented them, so a record of one it has no row for yet waits in uiSurfaces (the
 *  stream's event takes it up: withKnownSurfaces). Never a second row, never an older word over a later one. */
export function adoptedSurface(h: SurfaceHolders, record: UiSurfaceRecord): Partial<Pick<SurfaceHolders, 'uiSurfaces' | 'threads' | 'childThreads'>> | null {
  const key = surfaceKey(record)
  if (!supersedes(record, h.uiSurfaces[key])) return null
  const into = (rows: ThreadEntry[] | undefined, live: boolean): ThreadEntry[] | undefined => {
    if (!rows) return rows
    if (live && !rows.some((e) => e.kind === 'ui' && e.surface?.surface_id === record.surface_id)) return rows
    return upsertSurface(rows, record.run_id, record)
  }
  const thread = into(h.threads[record.run_id], !!h.streamed[record.run_id])
  const child = into(h.childThreads[record.run_id], !!h.childStreamed[record.run_id])
  return {
    uiSurfaces: { ...h.uiSurfaces, [key]: record },
    ...(thread && thread !== h.threads[record.run_id] ? { threads: { ...h.threads, [record.run_id]: thread } } : {}),
    ...(child && child !== h.childThreads[record.run_id] ? { childThreads: { ...h.childThreads, [record.run_id]: child } } : {}),
  }
}

/** A run event as the page may take it in: a `ui_surface` event carrying a session surface that its run may not
 *  present (sessionEventRefusal — the run as the page's rows know it, never as the event says) loses its record: the
 *  rows say a surface arrived that the page could not read, and nothing is shown or adopted (neither as the run's own
 *  row nor at an anchor). Every other event, a run surface's included, is passed as it is. Every entry that hears run
 *  events (a live stream, a child's stream, the replay) passes them through here before applyEvent / crossSurfaceOf. */
export function screenSurfaceEvent<T extends Pick<SSEItem, 'event' | 'data'>>(item: T, runId: string, run: RunFacts | null | undefined, session: SessionFacts | null | undefined): T {
  if (item.event !== 'ui_surface') return item
  const refused = sessionEventRefusal(item.data?.surface, runId, run, session)
  if (refused === null) return item
  return { ...item, data: { refused } }
}

/** The session surface a `ui_surface` event of run `runId` updates at another run's row (its anchor, the run that
 *  first presented it), or null: the event is not one (the run's own surface, any other event, a record whose writer
 *  is not this run or that is not a session surface). */
export function crossSurfaceOf(runId: string, item: Pick<SSEItem, 'event' | 'data'>): UiSurfaceRecord | null {
  if (item.event !== 'ui_surface') return null
  const record = item.data?.surface
  return surfaceEventRole(runId, record) === 'cross' ? record as UiSurfaceRecord : null
}

/** A UI task's line in its run: the action it came from and where it stands. */
export function taskLine(task: Pick<UiTaskRecord, 'action_id' | 'surface_id' | 'status' | 'error' | 'data'>): string {
  const where = `UI task · action ${task.action_id} on surface ${task.surface_id}`
  const data = task.data !== null && task.data !== undefined ? ' · result data sent to the surface' : ''
  switch (task.status) {
    case 'queued': return `${where} · queued`
    case 'running': return `${where} · running${data}`
    case 'succeeded': return `${where} · done${data}`
    case 'cancelled': return `${where} · stopped`
    default: return `${where} · failed${task.error ? `: ${task.error.message}` : ''}`
  }
}

export function applyEvent(thread: ThreadEntry[], runId: string, item: SSEItem): ThreadEntry[] {
  const handler = EVENT_ROWS[item.event]
  if (handler) return handler(thread, runId, item.data, item, item.id)
  return pushOnce(thread, { kind: 'system', runId, eventId: item.id, eventName: item.event, text: `${item.event}`, detail: item.data })
}

export function continuationLine(d: Record<string, unknown>): string {
  const reason = str(d.reason)
  const attempt = typeof d.recovery === 'number' && typeof d.of === 'number' ? ` (recovery ${d.recovery} of ${d.of})` : ''
  if (reason === 'request_boundary') return `Request boundary after ${str(d.requests_before)} requests — conversation saved, continues as segment ${str(d.segment)}`
  if (reason === 'transport_error') return `Connection to the model dropped — waited ${str(d.backoff_s)} s, resumed${attempt}; nothing was replayed`
  if (reason === 'provider_outage') return `Model route unavailable — waited ${str(d.backoff_s)} s, resumed${attempt}; nothing was replayed`
  if (reason === 'closing_turn') return `Closing turn: ${str(d.note)}`
  if (reason === 'context_overflow') return `The provider refused the conversation for its size — compacting once before the next request${attempt}`
  if (reason === 'output_limit') return `The answer reached the output limit — asked for the rest (${str(d.attempt)} of ${str(d.of)})`
  if (reason === 'no_answer') return `The response had no answer text — asked once more (${str(d.attempt)} of ${str(d.of)})`
  return reason ? `The run continues (${reason.replace(/_/g, ' ')})` : 'The run continues'
}

/** A stored transcript (a run whose live stream an earlier process held) as rows. `steers`: the run's steer records
 *  (the transcript's own list): a delivered one stands where its words are in the history (the user entry carrying its
 *  steer_id), every other one after the run's rows, by queued order. */
export function fromTranscript(runId: string, entries: TranscriptEntry[], admit: (record: UiSurfaceRecord) => boolean = () => true, steers: unknown[] = []): ThreadEntry[] {
  const out: ThreadEntry[] = []
  const records = new Map((Array.isArray(steers) ? steers : []).filter(isSteerRecord).filter((r) => r.run_id === runId).map((r) => [r.id, r] as const))
  const placed = new Set<string>()
  for (const e of entries) {
    if (e.kind === 'user') {
      // the run's opening words are rendered from the run itself, the harness's own prompts ("Continue.", a note) never;
      // only the words the person sent while the run worked are rows here
      const steerId = (e as { steer_id?: unknown }).steer_id
      if (typeof steerId === 'string' && steerId && !placed.has(steerId)) {
        placed.add(steerId)
        out.push(steerRowFor(runId, steerId, e.text ?? '', records))
      }
      continue
    }
    if (e.kind === 'agent') { if (e.text) out.push({ kind: 'agent', runId, text: e.text }) }
    else if (e.kind === 'thinking') out.push({ kind: 'thinking', runId, text: e.text })
    else if (e.kind === 'note') out.push({ kind: 'note', runId, text: e.text })
    else if (e.kind === 'activity') out.push({ kind: 'activity', runId, tool: e.tool, toolCallId: e.toolCallId, summary: e.summary,
      args: e.args ?? null, result: e.result, status: str(e.result?.status) || (e.running ? 'running' : 'ok'), running: e.running ?? false })
    else {
      // a surface where the transcript keeps it (its place among the words); the session's list brings its latest state
      const ui = e as { kind: string; surface?: unknown; input?: unknown }
      // (`admit`: the page's check of a session surface's runs — admitSessionRecord; a run surface always passes)
      if (ui.kind === 'ui' && isSurfaceRecord(ui.surface) && ui.surface.run_id === runId && admit(ui.surface)) {
        const next = upsertSurface(out, runId, ui.surface)
        out.splice(0, out.length, ...next)
      } else if (ui.kind === 'input' && isInputRecord(ui.input) && ui.input.run_id === runId) {
        // a request_input form of this run where the transcript keeps it (right after the call that showed it), as it
        // stands — pending, submitted, dismissed or closed; one input id is one row, a later updated_at the later word.
        // Another run's form (an inherited conversation's) is never this run's row.
        const next = upsertInput(out, runId, ui.input)
        out.splice(0, out.length, ...next)
      }
    }
  }
  for (const record of [...records.values()].filter((r) => !placed.has(r.id)).sort((a, b) => a.queued_seq - b.queued_seq)) {
    out.push(steerRowFor(runId, record.id, record.text, records))
  }
  return out
}

/** "950", "12k", "3.5M" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** A context_compacted event as a line: what it freed and the line it was asked over — above the threshold when the
 *  compaction before freed too little — and how much of a long summary was left out. */
export function compactionNote(d: Record<string, unknown>): string {
  if (d.status === 'failed' || d.status === 'skipped') return `Context not compacted: ${str(d.reason)} (~${str(d.estimate_tokens)} tokens, threshold ${str(d.threshold_tokens)})`
  const raised = typeof d.trigger_tokens === 'number' && typeof d.threshold_tokens === 'number' && d.trigger_tokens > d.threshold_tokens
    ? `, raised to ${d.trigger_tokens} after a compaction that freed too little` : ''
  const cut = typeof d.summary_cut_chars === 'number' && d.summary_cut_chars > 0 ? `; ${d.summary_cut_chars} characters of a long summary left out` : ''
  return `Context compacted: ~${str(d.estimate_tokens)} → ~${str(d.after_tokens)} tokens (threshold ${str(d.threshold_tokens)}${raised}${cut}; the earlier messages stay in the record)`
}

/** A request's token counts, or null when the provider reported none: the meter files a request it has no count for
 *  (a stream without a usage event, a failure before any count arrived, a figure that is no count) with every column
 *  0 and its cost unknown — a request the provider served reads its input, so all zeros are never a count. */
export function reportedTokens(r: { status: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }): { input: number; output: number; cached: number } | null {
  if (r.input_tokens === 0 && r.output_tokens === 0 && r.cache_read_tokens === 0 && r.cache_write_tokens === 0) return null
  return { input: r.input_tokens, output: r.output_tokens, cached: r.cache_read_tokens }
}

/** The requests of a run's usage the provider reported no count for (the meter's uncounted_requests; absent: none). */
export function uncountedRequests(usage: Record<string, unknown>): number {
  const n = usage.uncounted_requests
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/** "2 of 5 requests not counted": a run's token totals and cost cover only the requests the provider counted. */
export function uncountedNote(uncounted: number, requests: number | null): string {
  return `${uncounted}${requests != null && requests >= uncounted ? ` of ${requests}` : ''} request${(requests ?? uncounted) === 1 ? '' : 's'} not counted`
}

/** Money: unknown is a word, never $0.00, and says why — no price list, or requests the provider reported no count
 *  for (`counted`: how many of how many; a request record is one request). */
export function costText(amount: number | null | undefined | { cost_usd?: number | null; cost_cny?: number | null }, status: string | undefined, source?: string | null,
  counted: { uncounted: number; requests: number | null } = { uncounted: 0, requests: null }): string {
  const { uncounted, requests } = counted
  const usd = typeof amount === 'object' && amount !== null ? amount.cost_usd : amount
  const cny = typeof amount === 'object' && amount !== null ? amount.cost_cny : null
  const known = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  // Distinct denominations, never converted or summed. Suppress an unused zero currency in mixed totals.
  const values: string[] = []
  if (known(usd) && (usd !== 0 || !known(cny))) values.push(`$${usd.toFixed(4)}`)
  if (known(cny) && (cny !== 0 || !known(usd) || usd === 0)) values.push(`¥${cny.toFixed(4)} CNY`)
  const money = values.join(' + ')
  if (status === 'no_requests') return 'no requests'
  if (status === 'estimated' && money) return `≈ ${money} (${source ?? 'estimate'})`
  if (status === 'reported' && money) return `${money} (reported)`
  if (status === 'partial' && money) return `at least ${money} (${uncounted > 0 ? uncountedNote(uncounted, requests) : 'partly unpriced'})`
  if (status === 'unknown' && source) return `unknown (${source})`
  if (uncounted > 0) {
    if (requests === null) return `unknown (${uncountedNote(uncounted, null)})`
    if (uncounted >= requests) return `unknown (${requests === 1 ? 'the provider reported no count' : 'the provider reported no counts'})`
    // a counted request whose cost is still unknown had no price list
    return `unknown (no price list; ${uncountedNote(uncounted, requests)})`
  }
  return 'unknown (no price list)'
}

/** What a web search did: its query, or an action of the provider's search that is not one (OpenAI's open_page and
 *  find) by the page it opened or searched. */
export function searchLine(a: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? '' : String(v))
  if (a.action === 'open_page') return `open ${s(a.url)}`.trim()
  if (a.action === 'find' || a.action === 'find_in_page') return `find "${s(a.pattern)}"${a.url ? ` in ${s(a.url)}` : ''}`
  if (typeof a.action === 'string' && a.action !== 'search') return `${a.action}${a.url ? ` ${s(a.url)}` : ''}`
  return s(a.query)
}

/** A call still being written: what it works on, once named, and how much of it the model has written so far. */
export function formingLine(e: ThreadEntry): string {
  const a = e.args ?? {}
  const target = [a.path, a.title, a.url].find((v) => typeof v === 'string' && v !== '') as string | undefined
  const chars = e.forming?.chars ?? 0
  const size = chars < 1024 ? `${chars} characters` : `${(chars / 1024).toFixed(chars < 10_240 ? 1 : 0)} KB`
  return `${target ? `${target} · ` : ''}writing… ${size} so far`
}
