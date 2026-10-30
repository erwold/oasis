/** A relay participant's turn as the next participant reads it: its final answer as written (a very long one cut,
 *  the cut named with the run that holds the rest), one line per tool call it made — the tool, what it was about,
 *  the status, the ids its result named (the way the results are read again: bash_output by execution_id,
 *  fetch_url by source_id, read_file by path) — and the measured facts of its receipt. Built from the records
 *  alone, never by a model, and built once: the packet a turn is handed is part of that turn's own message, so a
 *  later turn's progress never rewrites what an earlier participant was told. */

import { plainToolMentions, uiSurfaceText, type Run } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { isRequest, isResponse, isRetryPrompt, isToolCall, isToolReturn, loadValue, type ModelMessage, type ToolReturnPart } from '../llm/messages.ts'
import { boundedReadUiReturn, inheritedMessageCount } from './transcript.ts'
import { text as promptText } from '../prompt_texts.ts'

export const MAX_ANSWER_CHARS = 24_000
export const MAX_CALL_LINES = 80
export const LINE_IDS = 6
export const LINE_SUMMARY_CHARS = 80
const OP_CHARS = 60

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const ID_TOKEN = /\b(?:p|s|ws|run|x|snap|cp|a|ap|v)_[0-9a-f]{6,}\b/g

function clip(value: string, limit: number): string {
  const chars = Array.from(value)
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : value
}

function argsDictOf(args: unknown): Rec {
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return {} }
  }
  return rec(args)
}

/** What a call was about: the op / topic / name / path / pattern / command / url it named. */
function opOf(args: unknown): string {
  const dict = argsDictOf(args)
  for (const key of ['op', 'topic', 'name', 'path', 'pattern', 'command', 'url', 'query', 'execution_id', 'source_id', 'asset_id', 'surface_id']) {
    const v = dict[key]
    if (typeof v === 'string' && v) return clip(v.replace(/\s+/g, ' ').trim(), OP_CHARS)
  }
  return ''
}

function idsOf(value: unknown): string[] {
  const seen: string[] = []
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? ''
  for (const m of text.matchAll(ID_TOKEN)) if (!seen.includes(m[0])) seen.push(m[0])
  return seen
}

/** One line for a call and its result: the tool, its object, the status, the ids named, a short summary. */
export function callLine(toolName: string, args: unknown, result: ToolReturnPart | { rejected: string } | null): string {
  let status = ''
  let summary = ''
  let ids: string[] = []
  if (result === null) {
    status = 'no result recorded'
  } else if (!('part_kind' in result)) {
    status = 'rejected'
    summary = result.rejected
  } else {
    // read_ui's return is the record the calling run read: a peer sees which surface, never its spec or values
    const content = toolName === 'read_ui' ? boundedReadUiReturn(result.content) : result.content
    if (typeof content === 'string') summary = content
    else {
      const c = rec(content)
      status = c.status != null && c.status !== '' ? String(c.status) : ''
      for (const key of ['summary', 'reason', 'error', 'note', 'message']) {
        const v = c[key]
        if (typeof v === 'string' && v) { summary = v; break }
      }
      if (!summary && typeof c.exit_code === 'number') summary = `exit ${c.exit_code}`
    }
    ids = idsOf(content).slice(0, LINE_IDS)
  }
  const op = opOf(args)
  const headText = [toolName, op].filter(Boolean).join(' ')
  let line = `[${[headText, status].filter(Boolean).join(' → ')}`
  if (ids.length) line += '; ids ' + ids.join(' ')
  if (summary) line += '; ' + clip(summary.replace(/\s+/g, ' ').trim(), LINE_SUMMARY_CHARS)
  return line + ']'
}

/** The lines of a run's own tool calls (the messages after the ones it inherited), in order. */
export function callLines(messages: ModelMessage[]): string[] {
  const results = new Map<string, ToolReturnPart | { rejected: string }>()
  for (const m of messages) {
    if (!isRequest(m)) continue
    for (const p of m.parts) {
      if (isToolReturn(p)) results.set(p.tool_call_id, p)
      else if (isRetryPrompt(p) && p.tool_call_id) results.set(p.tool_call_id, { rejected: typeof p.content === 'string' ? p.content : JSON.stringify(p.content) })
    }
  }
  const lines: string[] = []
  for (const m of messages) {
    if (!isResponse(m)) continue
    for (const p of m.parts) if (isToolCall(p)) lines.push(callLine(p.tool_name, p.args, results.get(p.tool_call_id) ?? null))
  }
  return lines
}

/** The measured facts of a receipt as one line. */
export function measuredLine(run: Run): string {
  const mechanical = rec(run.receipt.mechanical)
  const checks = rec(mechanical.checks)
  const diff = rec(mechanical.diff)
  // what was measured, and only that: a count of nothing is left out (a run that searched the web changed no file
  // and ran no check — saying "0 files changed, checks 0 / 0 / 0 / 0" tells the next reader nothing)
  const n = (v: unknown) => Number(v ?? 0)
  const parts = [`status ${run.status}${run.error ? ` (${clip(String(run.error), 120)})` : ''}`]
  if (n(mechanical.tool_calls) || n(mechanical.refused_calls) || n(mechanical.failed_executions)) {
    parts.push([`${n(mechanical.tool_calls)} tool call(s)`, ...(n(mechanical.refused_calls) ? [`${n(mechanical.refused_calls)} refused`] : []), ...(n(mechanical.failed_executions) ? [`${n(mechanical.failed_executions)} failed execution(s)`] : [])].join(', '))
  }
  if (n(diff.files)) parts.push(`${n(diff.files)} file(s) changed${diff.added != null ? ` (+${String(diff.added)} −${String(diff.removed ?? '?')})` : ''}`)
  if (n(checks.passed) || n(checks.failed) || n(checks.unknown) || n(checks.not_run)) parts.push(`checks ${n(checks.passed)} passed / ${n(checks.failed)} failed / ${n(checks.unknown)} unknown / ${n(checks.not_run)} not run`)
  const checkpoints = Array.isArray(mechanical.checkpoints) ? (mechanical.checkpoints as string[]) : []
  if (checkpoints.length) parts.push(`checkpoint ${checkpoints[checkpoints.length - 1]}`)
  const line = typeof mechanical.budget_reached === 'string' ? mechanical.budget_reached : typeof mechanical.budget_exceeded === 'string' ? mechanical.budget_exceeded : null
  if (line) parts.push(`budget line ${line}`)
  return parts.join('; ') + '.'
}

/** The packet of a finished relay turn: [turn number, speaker id] name it; the rest comes from the run's records.
 *  `plain`: for a reader without the harness's tools (ChatGPT on the web) — the calls' lines without the tools that
 *  read their results again. */
export function peerPacket(conn: Conn, run: Run, o: { turn: number; speaker: string; plain?: boolean }): string {
  return packetWithHeading(conn, run, promptText('packet.turn', { turn: o.turn, speaker: o.speaker, run_id: run.id }), o.plain)
}

/** The packet of a finished interaction node: [node id, speaker id] name it. `earlier`: the node's earlier runs, the
 *  attempts its last run carried on (a step that failed and was continued) — what they did stays part of the step:
 *  their tool calls and measured facts follow, each attempt under its own line. */
export function nodePacket(conn: Conn, run: Run, o: { node: string; speaker: string; plain?: boolean; earlier?: Run[]; full?: boolean }): string {
  const packet = packetWithHeading(conn, run, promptText('packet.node', { node: o.node, speaker: o.speaker, run_id: run.id }), o.plain, o.full)
  const attempts = (o.earlier ?? []).map((r) => promptText('packet.node_attempt', { node: o.node, run_id: r.id, calls: callsBlock(conn, r, o.plain ?? false), measured: measuredLine(r) }))
  return [packet, ...attempts].join('\n')
}

/** The packet under its heading: the answer as written (cut, the cut named), one line per tool call, the measured facts. */
export function packetWithHeading(conn: Conn, run: Run, heading: string, plain = false, full = false): string {
  // another agent's words name no tool: a token it quoted (from a page, a file) reads as its name
  const finalText = typeof run.receipt.final_text === 'string' ? (full ? run.receipt.final_text : plainToolMentions(run.receipt.final_text.trim())) : ''
  let answer = finalText || promptText('relay.peer_no_answer')
  const chars = Array.from(answer)
  if (!full && chars.length > MAX_ANSWER_CHARS) answer = chars.slice(0, MAX_ANSWER_CHARS).join('') + '\n' + promptText('relay.peer_answer_cut', { count: chars.length - MAX_ANSWER_CHARS, run_id: run.id })
  return promptText('packet.body', { heading, answer, calls: uiBlock(conn, run) + callsBlock(conn, run, plain), measured: measuredLine(run) })
}

export const MAX_UI_LINES = 10
export const UI_LINE_CHARS = 600

/** The surfaces a run showed the person, as their words (title, id, revision, fallback): never a spec or a document. */
function uiBlock(conn: Conn, run: Run): string {
  const surfaces = repo.listUiSurfaces(conn, run.session_id, run.id)
  if (!surfaces.length) return ''
  const lines = surfaces.slice(0, MAX_UI_LINES).map((s) => uiSurfaceText(s, UI_LINE_CHARS))
  if (surfaces.length > MAX_UI_LINES) lines.push(promptText('relay.peer_calls_cut', { count: surfaces.length - MAX_UI_LINES }).replace('calls', 'surfaces'))
  return promptText('packet.ui', { count: surfaces.length, lines: lines.join('\n') })
}

/** A run's own tool calls as a block of lines; a run that called no tool says nothing about tools. */
function callsBlock(conn: Conn, run: Run, plain: boolean): string {
  let lines: string[] = []
  const raw = repo.getRunHistory(conn, run.id)
  if (raw) {
    try { lines = callLines(loadValue(JSON.parse(raw)).slice(inheritedMessageCount(conn, run))) } catch { lines = [] }
  }
  const count = lines.length
  if (lines.length > MAX_CALL_LINES) lines = [...lines.slice(0, MAX_CALL_LINES), promptText('relay.peer_calls_cut', { count: lines.length - MAX_CALL_LINES })]
  return count ? promptText(plain ? 'packet.calls_plain' : 'packet.calls', { count, lines: lines.join('\n') }) : ''
}
