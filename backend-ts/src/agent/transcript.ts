/** A run's stored history rebuilt as thread entries (what the UI shows for a run whose live stream an earlier
 *  process held): user turns, agent prose, tool calls with their results, harness notes. */

import { uiSurfaceScope, type Run, type SteerRecord, type TranscriptEntry, type UiInputRecord, type UiSurfaceRecord } from '@oasis-code/contract'
import { PROMPT_TEXT } from '../prompt_texts.ts'
import { isSteerHeader } from './steering.ts'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { projectedCount, projectedOwnHistory } from '../db/history_projection.ts'
import { DbReadCache, jsonWeight } from '../db/read_cache.ts'
import { isImagePiece } from '../llm/images.ts'
import { answerText, isModelMessages, type BuiltinToolReturnPart, type ResponsePart } from '../llm/messages.ts'
import { builtinResult } from './events.ts'
import { closeDanglingToolCalls } from './runner.ts'

// Retain counts and only a run's OWN messages, never all its repeated inherited prefix. A DB change evicts
// both projections. Auxiliary records (forms, surfaces, steers, compactions) and status are read on every request.
const continuationCounts = new DbReadCache<number | null>(4096, 512 * 1024, () => 16)
const ownHistories = new DbReadCache<{ messages: unknown; offset: number }>(256, 8 * 1024 * 1024, jsonWeight)

function parsedHistory(raw: string | null): unknown {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return null }
}

function continuationCount(conn: Conn, id: string, observed?: (messages: unknown) => void): number | null {
  return continuationCounts.read(conn, id, () => {
    const projected = projectedCount(conn, id)
    if (projected) return projected.count
    const raw = repo.getRunHistory(conn, id)
    const messages = parsedHistory(raw)
    observed?.(messages)
    // Only these exact empty records fall back to the preceding run, as the runner does. An invalid nonempty
    // record stops the search at zero; dangling calls add the same closing message the runner would append.
    if (!raw || raw === '[]') return null
    return isModelMessages(messages) ? closeDanglingToolCalls(messages).length : 0
  })
}

/** Rebuild a DB record without rereading/reparsing its parent for every continued run. The raw rebuildTranscript
 *  below remains the oracle for the slice and all rendering rules. No rendered UI/state is cached here. */
export function rebuildStoredTranscript(conn: Conn, run: Pick<Run, 'id' | 'resumes_run_id'>, ended: string | null = null,
  surfaces: UiSurfaceRecord[] = [], inputs: UiInputRecord[] = [], steers: SteerRecord[] = [], compactions: repo.StoredEvent[] = []): TranscriptEntry[] {
  const own = ownHistories.read(conn, `${run.id}:${run.resumes_run_id ?? ''}`, () => {
    const from = inheritedMessageCount(conn, run)
    const projected = projectedOwnHistory(conn, run.id, from)
    if (projected) return projected
    let messages: unknown
    let read = false
    continuationCount(conn, run.id, (value) => { messages = value; read = true })
    if (!read) messages = parsedHistory(repo.getRunHistory(conn, run.id))
    const offset = Array.isArray(messages) && from > 0 && from <= messages.length ? from : 0
    return { messages: Array.isArray(messages) ? messages.slice(offset) : messages, offset }
  })
  // Entries can contain objects from message parts. Callers must not mutate a subsequent request's projection.
  return rebuildTranscriptMessages(structuredClone(own.messages), 0, ended, surfaces, inputs, steers, compactions, own.offset)
}

/** How many messages at the head of a run's history came from the run it continued: the runner loads that run's
 *  history (its dangling tool calls closed — one message more when there were any), carries it across providers
 *  message for message, and appends this run's own request after it. */
export function inheritedMessageCount(conn: Conn, run: Pick<Run, 'resumes_run_id'>): number {
  // the conversation the run continued, found as the runner found it: the resumed run's record, or — when that run
  // kept none (cut off before its first request) — the record it was itself continuing, back along the chain
  let from: string | null = run.resumes_run_id
  const walked = new Set<string>()
  while (from !== null && !walked.has(from)) {
    walked.add(from)
    const count = continuationCount(conn, from)
    if (count !== null) return count
    from = repo.getRun(conn, from)?.resumes_run_id ?? null
  }
  return 0
}

export const UNREADABLE_HISTORY = "This run's transcript is unavailable: its stored history could not be read."

const SUMMARY_KEYS = new Set(['status', 'reason', 'path', 'op', 'exit_code', 'execution_id', 'checkpoint_id', 'count', 'truncated',
  'total_lines', 'from_line', 'to_line', 'duration_ms', 'commit', 'files', 'diff', 'stdout', 'stderr', 'conflict',
  // computer use: which page, what was done, where it landed
  'surface', 'action', 'url', 'title', 'snapshot_id', 'screenshot_display_asset_id',
  // present_ui: which surface, which revision (the surface itself is the 'ui' entry, never the tool's return), its scope
  // and, for a conflict, the revisions; read_ui: the same few (never the record it returned to the run)
  'surface_id', 'revision', 'scope', 'expected_revision', 'current_revision',
  // request_input: which form (its values are the person's answer, read from the form's record); return_ui_result: which task
  'input_id', 'task_id'])

/** The entries of a history from message `from` on (0: all of it); the messages before are the conversation the run
 *  inherited and shows under the runs that made them. `ended` is the status a finished run ended with: a call of its
 *  no return answered (a crash, a record from before the harness answered every call of a stopped run) is closed
 *  as the run ended — cancelled, or interrupted — never left running; null while the run runs. */
export function rebuildTranscript(historyJson: string | null, from = 0, ended: string | null = null, surfaces: UiSurfaceRecord[] = [], inputs: UiInputRecord[] = [], steers: SteerRecord[] = [], compactions: repo.StoredEvent[] = []): TranscriptEntry[] {
  return rebuildTranscriptMessages(parsedHistory(historyJson), from, ended, surfaces, inputs, steers, compactions)
}

function rebuildTranscriptMessages(messages: unknown, from: number, ended: string | null, surfaces: UiSurfaceRecord[], inputs: UiInputRecord[], steers: SteerRecord[], compactions: repo.StoredEvent[], offset = 0): TranscriptEntry[] {
  const maintenance = compactionEntries(compactions, ended)
  // a steer delivered in the run: where its steer_delivered event stands among the run's events
  const steerSeq = new Map(steers.map((st) => [st.id, st.delivered_seq]))
  // the surfaces the run presented, each shown once — where its first successful present_ui ran (see uiAt)
  const pending = new Map(surfaces.map((s) => [s.surface_id, s]))
  // the run's request_input forms as they stand (pending, answered or closed), each right after the call that showed it
  const forms = new Map(inputs.map((i) => [i.tool_call_id, i]))
  const rest = (entries: TranscriptEntry[]): TranscriptEntry[] => [...entries, ...maintenance.values(), ...[...pending.values()].map((surface) => ({ kind: 'ui' as const, surface })),
    ...[...forms.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)).map((input) => ({ kind: 'input' as const, toolCallId: input.tool_call_id, input }))]
  // a record that no longer reads is said to be unavailable: an empty transcript would pass for a run that said nothing
  const unreadable: TranscriptEntry[] = [{ kind: 'note', text: UNREADABLE_HISTORY }]
  if (!Array.isArray(messages)) return rest(unreadable)
  const entries: TranscriptEntry[] = []
  const calls = new Map<string, TranscriptEntry>()
  const firstOwn = from > 0 && from <= messages.length ? from : 0
  const own = (messages as Record<string, unknown>[]).slice(firstOwn)
  for (const [index, message] of own.entries()) {
    // covers is an absolute message index in the append-only record, including the inherited prefix.
    let reported = false
    for (const [id, entry] of maintenance) if (entry.compaction?.covers === offset + firstOwn + index) {
      entries.push(entry)
      maintenance.delete(id)
      reported ||= entry.compaction.status === 'compacted'
    }
    const kind = message.kind
    const parts = Array.isArray(message.parts) ? (message.parts as Record<string, unknown>[]) : []
    if (kind === 'request' && message.compaction && typeof message.compaction === 'object') {
      // The lifecycle event supplies the before/after estimates. Older records have only the before count;
      // neither invent an after count nor repeat the model's private maintenance summary in the thread.
      const compaction = message.compaction as Record<string, unknown>
      if (!reported) entries.push({ kind: 'compaction', compaction: { status: 'compacted', estimate_tokens: compaction.tokens_before, after_tokens: null }, running: false })
      continue
    }
    // a response's text parts that follow each other are one answer (a provider that cites splits it at each citation)
    let words: Record<string, unknown>[] = []
    const closeWords = () => {
      const text = answerText(words as unknown as ResponsePart[])
      if (text) entries.push({ kind: 'agent', text })
      words = []
    }
    for (const part of parts) {
      const pk = part.part_kind
      if (kind === 'response' && pk === 'text') { words.push(part); continue }
      closeWords()
      if (kind === 'request') {
        if (pk === 'user-prompt' && typeof part.steer_id === 'string') {
          // the person's words sent while the run worked: exactly as sent, with where they were delivered
          const seq = steerSeq.get(part.steer_id)
          entries.push({ kind: 'user', text: typeof part.content === 'string' ? part.content : '', steer_id: part.steer_id, ...(typeof seq === 'number' ? { seq } : {}) })
        } else if (pk === 'user-prompt' && part.origin === 'app' && isSteerHeader(part.content)) {
          // the app's line before them is the harness's framing, not a note to show
        } else if (pk === 'user-prompt') {
          const content = part.content
          const pieces = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c): c is string => typeof c === 'string') : []
          const text = pieces.join('\n')
          if (text.startsWith('App note') || text.startsWith('Harness note')) entries.push({ kind: 'note', text })
          // the person's words are the last piece of a two-piece first message; an older record had them after a heading
          else entries.push({ kind: 'user', text: pieces.length > 1 ? pieces[pieces.length - 1]! : userTextOf(text) })
        } else if (pk === 'tool-return') {
          const call = calls.get(String(part.tool_call_id))
          const summary = summarizeReturn(part.content, String(part.tool_name))
          if (call) { call.result = summary; call.running = false }
          else entries.push({ kind: 'activity', tool: String(part.tool_name), toolCallId: String(part.tool_call_id), result: summary, running: false })
          const shown = uiAt(part, pending)
          if (shown !== null) entries.push(shown)
        } else if (pk === 'retry-prompt') {
          const call = calls.get(String(part.tool_call_id))
          if (call) {
            call.result = { status: 'retry', summary: (typeof part.content === 'string' ? part.content : JSON.stringify(part.content)).slice(0, 300) }
            call.running = false
          }
        }
      } else if (kind === 'response') {
        if (pk === 'thinking' && part.content) entries.push({ kind: 'thinking', text: String(part.content) })
        else if (pk === 'builtin-tool-call') {
          // the provider's own tool (its web search): a tool row like the harness's, its results in the same response
          const args = part.args && typeof part.args === 'object' && !Array.isArray(part.args) ? (part.args as Record<string, unknown>) : null
          const entry: TranscriptEntry = { kind: 'activity', tool: String(part.tool_name), toolCallId: String(part.tool_call_id), summary: JSON.stringify(args ?? {}).slice(0, 240), args, running: true }
          calls.set(String(part.tool_call_id), entry)
          entries.push(entry)
        } else if (pk === 'builtin-tool-return') {
          const result = builtinResult(part as BuiltinToolReturnPart)
          const call = calls.get(String(part.tool_call_id))
          if (call) { call.result = result; call.running = false }
          else entries.push({ kind: 'activity', tool: String(part.tool_name), toolCallId: String(part.tool_call_id), result, running: false })
        }
        else if (pk === 'tool-call') {
          const args = part.args
          const preview = typeof args === 'string' ? args : JSON.stringify(args ?? null)
          const entry: TranscriptEntry = {
            kind: 'activity', tool: String(part.tool_name), toolCallId: String(part.tool_call_id), summary: preview.slice(0, 240),
            args: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : null, running: true,
          }
          calls.set(String(part.tool_call_id), entry)
          entries.push(entry)
          const form = part.tool_name === 'request_input' ? forms.get(String(part.tool_call_id)) : undefined
          if (form !== undefined) {
            forms.delete(form.tool_call_id)
            entries.push({ kind: 'input', toolCallId: form.tool_call_id, input: form })
          }
        }
      }
    }
    closeWords()
  }
  if (ended !== null) {
    // a call whose return the record never got says so — not that it never ran: a record from before the harness
    // answered every call of a stopped run holds calls that did run (their output arrived) beside ones that did not
    for (const call of calls.values()) {
      if (!call.running) continue
      call.running = false
      call.result = ended === 'cancelled'
        ? { status: 'cancelled', reason: 'stopped before its result was recorded; whether it ran and what it changed is unknown' }
        : { status: 'interrupted', reason: `the run ended (${ended}) before its result was recorded; whether it ran and what it changed is unknown` }
    }
  }
  return rest(entries)
}

/** One static record per attempt when reopening a finished run, including failed / stopped summaries without
 *  a history marker. A start without its end after a crash is interrupted, never an everlasting spinner. */
function compactionEntries(events: repo.StoredEvent[], ended: string | null): Map<string, TranscriptEntry> {
  const entries = new Map<string, TranscriptEntry>()
  for (const event of events) {
    if (event.event !== 'context_compacting' && event.event !== 'context_compacted') continue
    const id = typeof event.data.compaction_id === 'string' ? event.data.compaction_id : `event-${event.seq}`
    const previous = entries.get(id)
    if (event.event === 'context_compacting' && previous) continue
    const running = event.event === 'context_compacting' && ended === null
    const status = event.event === 'context_compacting' ? (running ? 'running' : 'interrupted') : event.data.status
    entries.set(id, { kind: 'compaction', seq: previous?.seq ?? event.seq, running,
      compaction: { ...previous?.compaction, ...event.data, status } })
  }
  return entries
}

/** The 'ui' entry a tool return stands for: present_ui's successful return of a surface not shown yet. A tool runs
 *  once its response has ended — after the words that response streamed, whichever of the parts came first — so
 *  the surface sits where its return is (after those words, as the thread showed it live), not beside the call;
 *  the latest revision is shown there, as the live block was updated in place. */
function uiAt(part: Record<string, unknown>, pending: Map<string, UiSurfaceRecord>): TranscriptEntry | null {
  if (part.tool_name !== 'present_ui' || pending.size === 0) return null
  const content = part.content && typeof part.content === 'object' && !Array.isArray(part.content) ? (part.content as Record<string, unknown>) : null
  if (content === null || content.status !== 'ok' || typeof content.surface_id !== 'string') return null
  const surface = pending.get(content.surface_id)
  if (surface === undefined) return null
  // a return of the other scope is another surface (a session surface anchored elsewhere, which this run updated)
  if ((content.scope === 'session' ? 'session' : 'run') !== uiSurfaceScope(surface)) return null
  pending.delete(content.surface_id)
  return { kind: 'ui', surface }
}

/** A surface record inside a tool's return, as a thread row may hold it: its id, revision and scope. */
export function boundedSurfaceReturn(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const r = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof r.surface_id === 'string') out.surface_id = r.surface_id.slice(0, 64)
  if (typeof r.revision === 'number') out.revision = r.revision
  out.scope = r.scope === 'session' ? 'session' : 'run'
  return out
}

/** read_ui's return as the records of the thread and a peer show it: its status, which surface and revision, why it
 *  was refused — never the record the calling run got. */
export function boundedReadUiReturn(content: unknown): Record<string, unknown> {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return {}
  const c = content as Record<string, unknown>
  const out: Record<string, unknown> = { status: typeof c.status === 'string' ? c.status : '' }
  if (c.surface !== undefined) Object.assign(out, boundedSurfaceReturn(c.surface))
  if (typeof c.surface_id === 'string') out.surface_id = c.surface_id.slice(0, 64)
  if (c.scope === 'session' || c.scope === 'run') out.scope = c.scope
  if (typeof c.reason === 'string') out.reason = c.reason.slice(0, 200)
  if (Array.isArray(c.errors)) out.errors = c.errors.slice(0, 3).map((e) => String(e).slice(0, 200))
  return out
}

function userTextOf(text: string): string {
  const marker = 'User request: '
  const idx = text.lastIndexOf(marker)
  return idx >= 0 ? text.slice(idx + marker.length) : text
}

/** generate_image's own return as the live row showed it: generated, the one image shown, the references. */
function generatedImageOf(c: Record<string, unknown>): Record<string, unknown> {
  const id = c.asset_id
  if (c.status !== 'ok' || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !Number.isInteger(c.width) || !Number.isInteger(c.height)) return {}
  const label = typeof c.name === 'string' ? c.name.slice(0, 120) : 'generated-image.png'
  const requested = c.requested && typeof c.requested === 'object' ? (c.requested as Record<string, unknown>) : {}
  const refs = Array.isArray(requested.references) ? requested.references.filter((r): r is string => typeof r === 'string').slice(0, 5) : []
  return { generated: true, shown: [{ asset_id: id, width: c.width, height: c.height, label }], ...(refs.length ? { references: refs } : {}) }
}

function summarizeReturn(content: unknown, tool = ''): Record<string, unknown> {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(content as Record<string, unknown>)) if (SUMMARY_KEYS.has(k)) out[k] = v
    // `surface` names a page computer use acted on (a word); a record read_ui returned is told by its id, revision
    // and scope only — never its spec, document or values
    if (out.surface !== undefined && typeof out.surface !== 'string') {
      const record = boundedSurfaceReturn(out.surface)
      delete out.surface
      Object.assign(out, record)
    }
    // a look computer use took: the thread shows the picture it was (the session's image), never its bytes
    const shot = (content as Record<string, unknown>).screenshot
    if (isImagePiece(shot)) out.screenshot_asset_id = shot.asset_id
    // an image generate_image made: the thread shows it again as it did live (the session's image, by its id and its
    // measured size), with the references an edit used
    if (tool === 'generate_image') Object.assign(out, generatedImageOf(content as Record<string, unknown>))
    // an image read_file showed its model: the thread shows it again as it did live (the session's image, by its id
    // and its size, labelled with the path read)
    const read = (content as Record<string, unknown>).image
    if (tool === 'read_file' && isImagePiece(read)) out.shown = [{ asset_id: read.asset_id, width: read.width, height: read.height, label: typeof out.path === 'string' ? out.path : read.name }]
    if (Array.isArray(out.files)) out.files = out.files.slice(0, 50)
    for (const key of ['diff', 'stdout', 'stderr']) {
      const value = out[key]
      if (typeof value === 'string' && value.length > 4000) out[key] = value.slice(0, 4000) + '…'
    }
    return out
  }
  return { summary: String(content).slice(0, 300) }
}

/** The most of a call's return the page is handed at once: past it, each long text is cut and the call says so. */
export const CALL_DETAIL_CHARS = 400_000

/** One tool call of a history as its model saw it — the name, the arguments and the whole return (the transcript's
 *  rows keep a summary) — or null when the history holds no such call. A return past CALL_DETAIL_CHARS has its long
 *  texts cut (`cut` true); one with no return yet has a null result. */
export function toolCallOf(historyJson: string | null, toolCallId: string): { tool: string; args: unknown; result: unknown; cut: boolean } | null {
  if (!historyJson) return null
  let messages: unknown
  try { messages = JSON.parse(historyJson) } catch { return null }
  if (!Array.isArray(messages)) return null
  let call: { tool: string; args: unknown } | null = null
  let result: unknown = null
  for (const message of messages as Record<string, unknown>[]) {
    for (const part of Array.isArray(message.parts) ? (message.parts as Record<string, unknown>[]) : []) {
      if (part.tool_call_id !== toolCallId) continue
      if (part.part_kind === 'tool-call') {
        let args = part.args
        if (typeof args === 'string') { try { args = JSON.parse(args) } catch { /* the model's own text: shown as it is */ } }
        call = { tool: String(part.tool_name), args }
      } else if (part.part_kind === 'tool-return') result = part.content
    }
  }
  if (call === null) return null
  const whole = JSON.stringify(result ?? null).length
  if (whole <= CALL_DETAIL_CHARS) return { ...call, result, cut: false }
  // each text gets its share of the budget, so a long file's head and a command's output both still show
  const cutText = (value: unknown): unknown => typeof value === 'string' ? value.slice(0, Math.max(1_000, Math.floor(CALL_DETAIL_CHARS * value.length / whole)))
    : Array.isArray(value) ? value.map(cutText) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutText(v)])) : value
  return { ...call, result: cutText(result), cut: true }
}
