/** The outbox's pure part: what a task event carries (measured from the run and its receipt, never from the
 *  agent's words alone) and how a batch of events reads as the next message to the director. A task event is a
 *  new turn of the conversation — not a late return value of a tool call that ended long ago — and the message says
 *  so first, so the director does not take it for an instruction from the person. */

import type { DirectorOutboxEvent, DirectorToolSurface, Run } from '@oasis-code/contract'
import { surfaceText } from './surfaces/index.ts'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

/** How many attempts a task event gets before it is marked failed (a turn that errors sends its events back to
 *  pending; the third failure keeps them out of the next turn and the page shows them). */
export const EVENT_MAX_ATTEMPTS = 3
const HEAD_CHARS = 400

function head(text: unknown, chars = HEAD_CHARS): string {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  return t.length <= chars ? t : `${t.slice(0, chars)}…`
}

/** The payload of a run_finished event: the measured facts of the receipt and enough of the run to name it. */
export function runFinishedPayload(run: Run, receipt: Rec): Rec {
  const mechanical = rec(receipt.mechanical)
  const produced = rec(receipt.produced)
  const checks = rec(mechanical.checks)
  const diff = rec(mechanical.diff)
  return {
    run_id: run.id, label: run.label, model: run.model, spawned_by: run.spawned_by, is_thread_run: run.parent_run_id === null && run.work_order === null,
    status: run.status, error: run.error, lock_violations: Number(mechanical.lock_violations ?? 0), failed_executions: Number(mechanical.failed_executions ?? 0),
    checks: { passed: Number(checks.passed ?? 0), failed: Number(checks.failed ?? 0), unknown: Number(checks.unknown ?? 0), not_run: Number(checks.not_run ?? 0) },
    files_changed: Number(diff.files ?? 0), lines_added: diff.added ?? null, lines_removed: diff.removed ?? null,
    checkpoints: Array.isArray(mechanical.checkpoints) ? mechanical.checkpoints : [], final_checkpoint_id: produced.final_checkpoint_id ?? null,
    refused_calls: Number(mechanical.refused_calls ?? 0), tool_calls: Number(mechanical.tool_calls ?? 0),
    user_text_head: head(run.user_text, 200), final_text_head: head(receipt.final_text ?? ''),
    workspace_id: run.workspace_id, finished_at: run.finished_at,
    // what a v2 message names (v1's lines never read these): the whole answer's length, where to read it, and who
    // started the run and where it stands — the run's own record, not an inference
    final_text_chars: typeof receipt.final_text === 'string' ? receipt.final_text.length : 0,
    answer_ref: { tool: 'get_run', run_id: run.id, field: 'receipt.final_text' },
    interaction_id: run.interaction_id ?? null, relay_id: run.relay_id ?? null, session_id: run.session_id,
    ...(collabOf(run) ? { collab: collabOf(run) } : {}),
  }
}

function collabOf(run: Run): Rec | null {
  const collab = (run as unknown as Rec).collab
  return collab && typeof collab === 'object' ? (collab as Rec) : null
}

function eventLines(event: DirectorOutboxEvent): string[] {
  const p = event.payload
  if (event.kind === 'interaction_finished') return [`- interaction execution index (all nodes, answer references; no inferred verdict): ${JSON.stringify(p)}`]
  if (event.kind !== 'run_finished') return [`- ${event.kind} ${event.ref_id}: ${JSON.stringify(p).slice(0, 600)}`]
  const checks = rec(p.checks)
  const cause = event.cause_turn_id
    ? `started by your instruction (turn ${event.cause_turn_id})`
    : p.spawned_by === 'wake' ? 'started by oasis-code: a watch the conversation\'s agent set fired (not by you, not by the person)'
    : p.is_thread_run ? 'started by the person from oasis-code (not by you); read it, do not re-send it' : 'started outside this conversation (the person, or another director client)'
  const lines = [
    `- run ${event.ref_id}${p.label ? ` "${String(p.label)}"` : ''} on ${String(p.model ?? '?')} — ${cause}`,
    `  status: ${String(p.status)}${p.error ? ` (error: ${head(p.error, 200)})` : ''}; checks ${String(checks.passed ?? 0)} passed / ${String(checks.failed ?? 0)} failed / ${String(checks.unknown ?? 0)} unknown / ${String(checks.not_run ?? 0)} not run`
      + (Number(p.lock_violations ?? 0) ? `; ${String(p.lock_violations)} lock violation(s)` : '') + (Number(p.failed_executions ?? 0) ? `; ${String(p.failed_executions)} failed command(s)` : ''),
    `  measured: ${String(p.tool_calls ?? 0)} tool calls, ${String(p.refused_calls ?? 0)} refused; `
      + `${String(p.files_changed ?? 0)} file(s) changed${p.lines_added != null ? ` (+${String(p.lines_added)} −${String(p.lines_removed ?? '?')})` : ''}; `
      + `checkpoint: ${p.final_checkpoint_id ? String(p.final_checkpoint_id) : 'none'}`,
  ]
  if (p.user_text_head) lines.push(`  instruction (head): ${String(p.user_text_head)}`)
  if (p.final_text_head) lines.push(`  the agent's last words (head, its own account — judge by the receipt): ${String(p.final_text_head)}`)
  return lines
}

/** v2's lines of one event: the run's own facts, who started it (its recorded origin), where its whole answer is read
 *  (get_run on that exact run), and the 400-character head marked as a head — never presented as the answer. */
function eventLinesV2(event: DirectorOutboxEvent): string[] {
  const p = event.payload
  if (event.kind === 'interaction_finished') return [`- interaction ${event.ref_id} ended (execution index; answers by run: get_run run_id): ${JSON.stringify(p)}`]
  if (event.kind !== 'run_finished') return [`- ${event.kind} ${event.ref_id}: ${JSON.stringify(p).slice(0, 600)}`]
  const checks = rec(p.checks)
  const collab = rec(p.collab)
  const origin = rec(collab.origin)
  const by = event.cause_turn_id ? `started by turn ${event.cause_turn_id} of this conversation${origin.tool_call_id ? ` (tool call ${String(origin.tool_call_id)})` : ''}`
    : origin.actor === 'person' ? 'started by the user in oasis-code'
    : origin.actor === 'watch' || p.spawned_by === 'wake' ? 'started by a watch of the session\'s main agent'
    : origin.actor === 'connector' ? `started by an MCP client${origin.client ? ` (${String(origin.client)})` : ''}`
    : origin.actor === 'director' ? 'started by another director conversation'
    : origin.actor === 'scheduler' ? 'started by the harness for a plan'
    : origin.actor === 'ui_task' ? 'started by a UI task'
    : p.is_thread_run ? 'started from oasis-code, not from this conversation' : 'started outside this conversation'
  const where = [collab.participant_role ? `participant ${String(collab.participant_id ?? '?')} (${String(collab.participant_role)})` : null,
    origin.request ? `request ${String(origin.request)}` : null, p.interaction_id ? `interaction ${String(p.interaction_id)}` : null, p.relay_id ? `relay ${String(p.relay_id)}` : null,
    p.session_id && p.session_id !== event.session_id ? `session ${String(p.session_id)}` : null].filter(Boolean)
  const lines = [
    `- run ${event.ref_id}${p.label ? ` "${String(p.label)}"` : ''} on ${String(p.model ?? '?')} — ${by}${where.length ? `; ${where.join(', ')}` : ''}`,
    `  status: ${String(p.status)}${p.error ? ` (error: ${head(p.error, 200)})` : ''}; checks ${String(checks.passed ?? 0)} passed / ${String(checks.failed ?? 0)} failed / ${String(checks.unknown ?? 0)} unknown / ${String(checks.not_run ?? 0)} not run`
      + (Number(p.lock_violations ?? 0) ? `; ${String(p.lock_violations)} lock violation(s)` : '') + (Number(p.failed_executions ?? 0) ? `; ${String(p.failed_executions)} failed command(s)` : ''),
    `  measured: ${String(p.tool_calls ?? 0)} tool calls, ${String(p.refused_calls ?? 0)} refused; `
      + `${String(p.files_changed ?? 0)} file(s) changed${p.lines_added != null ? ` (+${String(p.lines_added)} −${String(p.lines_removed ?? '?')})` : ''}; `
      + `checkpoint: ${p.final_checkpoint_id ? String(p.final_checkpoint_id) : 'none'}`,
  ]
  if (p.user_text_head) lines.push(`  instruction (head): ${String(p.user_text_head)}`)
  const chars = Number(p.final_text_chars ?? 0)
  if (p.final_text_head) lines.push(`  final answer: ${chars ? `${chars} characters` : 'see get_run'}, read whole with get_run run_id=${event.ref_id}; its first ${HEAD_CHARS} characters: ${String(p.final_text_head)}`)
  return lines
}

/** The message a batch of events becomes: a labelled event block, the facts per event, what to do next — in the
 *  words of the surface the conversation holds (v1's are the baseline's, unchanged). */
export function taskEventMessage(sessionId: string, events: DirectorOutboxEvent[], surface: DirectorToolSurface = 'director.v1'): string {
  const lines = surface === 'director.v1' ? eventLines : eventLinesV2
  return [surfaceText(surface, 'director.task_event', { run_ids: events.map((e) => e.ref_id).join(', ') }), `session: ${sessionId}`, ...events.flatMap(lines)].join('\n')
}

/** The runs the person ran directly since the director last spoke, riding with its next turn: a labelled block
 *  before that turn's own words, the facts per event. */
export function personRunsMessage(events: DirectorOutboxEvent[], surface: DirectorToolSurface = 'director.v1'): string {
  const lines = surface === 'director.v1' ? eventLines : eventLinesV2
  return [surfaceText(surface, 'director.person_runs', { run_ids: events.map((e) => e.ref_id).join(', ') }), ...events.flatMap(lines)].join('\n')
}

/** The line a task-event turn's note shows as its question (the person did not write anything). */
export function taskEventQuestion(events: DirectorOutboxEvent[]): string {
  const names = events.map((e) => {
    const p = e.payload
    const what = e.kind === 'run_finished' ? `run ${e.ref_id}${p.label ? ` (${String(p.label)})` : ''} finished: ${String(p.status)}` : `${e.kind} ${e.ref_id}`
    return `- ${what}`
  })
  return `oasis-code task event${events.length === 1 ? '' : 's'}:\n${names.join('\n')}`
}

/** The ids of runs a director tool's result names: the tool that starts a run (start_run) answers with the run. */
export function runIdsOf(toolName: string, result: unknown): string[] {
  const r = rec(result)
  const ids: string[] = []
  const take = (v: unknown) => { if (typeof v === 'string' && /^run_[0-9a-f]+$/.test(v)) ids.push(v) }
  if (toolName === 'start_run' || toolName === 'start_relay') take(r.id)
  if (toolName === 'start_interaction' && Array.isArray(r.nodes)) for (const node of r.nodes) take(rec(node).run_id)
  return ids
}
