/** The director's tool calls of turns recorded before a call kept its arguments and outcome, completed once from the
 *  native director's own conversation: each turn's calls are the tool calls that follow its input there, matched in
 *  order by name, and the tool returns that answer them. A turn whose input is no longer in the conversation (it was
 *  compacted) keeps what it has. Nothing else is touched. */

import type { DirectorToolCall } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import { callOutcome, callSummary, keptArgs } from './tools.ts'
import * as store from './store.ts'

type Rec = Record<string, unknown>
const textOf = (content: unknown): string => (Array.isArray(content) ? content.filter((c): c is string => typeof c === 'string').join('\n') : typeof content === 'string' ? content : '')

/** A call recorded without its arguments and what came back. */
const lacksDetail = (c: Partial<DirectorToolCall>): boolean => c.args == null && !c.outcome
/** A call whose arguments are known but whose one-line summary is not (a plan recorded before plans had one). */
const lacksSummary = (c: Partial<DirectorToolCall>): boolean => !c.summary && c.args != null

export function backfillCallDetails(conn: Conn): number {
  let completed = 0
  const sessions = conn.all("SELECT id FROM director_sessions WHERE transport='native' AND history_json IS NOT NULL").map((r) => String(r.id))
  for (const id of sessions) {
    const turns = store.listTurns(conn, id).filter((t) => t.tool_calls.some((c) => lacksDetail(c) || lacksSummary(c)))
    if (!turns.length) continue
    let parts: Rec[] | null = null
    let returns = new Map<string, Rec>()
    const history = (): Rec[] => {
      if (parts !== null) return parts
      let messages: Rec[] = []
      try { messages = JSON.parse(store.getDirectorHistory(conn, id) ?? '[]') as Rec[] } catch { messages = [] }
      parts = messages.flatMap((m) => (m.parts as Rec[] | undefined) ?? [])
      returns = new Map(parts.filter((p) => p.part_kind === 'tool-return').map((p) => [String(p.tool_call_id), p]))
      return parts
    }
    for (const turn of turns) {
      let filled = turn.tool_calls
      // the arguments and what came back, from the director's own conversation: the calls after this turn's input
      if (turn.tool_calls.some(lacksDetail)) {
        const all = history()
        const head = turn.input.slice(0, 200)
        const start = all.findIndex((p) => p.part_kind === 'user-prompt' && head.length > 0 && textOf(p.content).includes(head))
        if (start >= 0) {
          const next = all.findIndex((p, i) => i > start && p.part_kind === 'user-prompt')
          const calls = all.slice(start, next < 0 ? all.length : next).filter((p) => p.part_kind === 'tool-call')
          const used = new Set<number>()
          filled = filled.map((c) => {
            if (!lacksDetail(c)) return c
            const i = calls.findIndex((p, j) => !used.has(j) && p.tool_name === c.name)
            if (i < 0) return c
            used.add(i)
            const call = calls[i]!
            let args: Rec = {}
            try { args = (typeof call.args === 'string' ? JSON.parse(call.args) : call.args ?? {}) as Rec } catch { args = {} }
            const back = returns.get(String(call.tool_call_id))
            const content = back?.content
            const failed = !!content && typeof content === 'object' && ((content as Rec).status === 'error' || /^refused/.test(String((content as Rec).status ?? '')))
            return { ...c, args: keptArgs(args), outcome: back ? callOutcome(content, failed) : '' }
          })
        }
      }
      // the one-line summary a call recorded without one gets from its arguments, as a new call's does
      filled = filled.map((c) => (lacksSummary(c) ? { ...c, summary: callSummary(c.name, c.args ?? {}) } : c))
      if (filled.some((c, i) => c !== turn.tool_calls[i])) {
        store.updateTurn(conn, turn.id, { tool_calls: filled })
        completed += 1
      }
    }
  }
  return completed
}
