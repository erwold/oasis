/** What a person points at, named inline (the coding counterpart of oasis state/entities.ts, see NOTICE): a file of
 *  the workspace (`@path`), a definition in it (`@path::symbol`), an agent of the model catalogue
 *  (`@[Label](agent:route-id)`, the chip the composer inserts) or a tool the agent has (`@[Computer](tool:computer)`).
 *  The thread draws them as chips; the message carries the file mentions the backend resolves and pins, the agents
 *  that take turns on it and the tools the person asked for. Pure, so node --test exercises it. */

import { agentMentionToken, agentMentionsOf, MENTION_TOOLS, mentionSegments, nextParticipantId, participantNames, participantsOf, toolMentionToken, type AgentMention, type MentionedParticipant, type MentionToolId, type ToolMention } from '@oasis-code/contract'

export type { AgentMention, MentionedParticipant, MentionToolId, ToolMention }
export { agentMentionToken, agentMentionsOf, nextParticipantId, participantNames, participantsOf }

export interface Mention { path: string; symbol?: string | null }
export type Segment = { text: string } | { mention: Mention; raw: string } | { agent: AgentMention; raw: string } | { tool: ToolMention; raw: string }

/** What an @ may follow to open a name: the start, whitespace, punctuation (a Chinese comma or full stop, a colon, a
 *  bracket) or a character of a script written without spaces (Chinese, Japanese, Korean: "地方@") — never a Latin
 *  letter or a digit (an e-mail). One class for the menu, the words and the chips. */
const OPENER = '(^|[\\s\\p{P}\\p{S}\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])'
const TOKEN = new RegExp(`${OPENER}@([\\w./-]+(?:::[\\w.$]+)?)`, 'gu')

// a path has a letter in it: "@400/500/1000" (a step in pasted notes) or "@0.87" is a number, never a file
const isPathLike = (p: string) => (p.includes('/') || p.includes('.')) && /\p{L}/u.test(p)

function fileSegments(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const token = m[2].replace(/[.,;:]+$/, '')
    const [path, symbol] = token.split('::')
    if (!isPathLike(path)) continue
    const start = (m.index ?? 0) + m[1].length
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ mention: { path, symbol: symbol || null }, raw: `@${token}` })
    last = start + 1 + token.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** The text split into plain runs, file-mention chips, agent chips and tool chips (an @word that is not path-like —
 *  a person, an email — stays text). */
export function segments(text: string): Segment[] {
  const out: Segment[] = []
  for (const piece of mentionSegments(text)) {
    if ('text' in piece) out.push(...fileSegments(piece.text))
    else out.push(piece)
  }
  return out
}

/** The file mentions a message carries, in order, once each. */
export function mentionsOf(text: string): Mention[] {
  const seen = new Set<string>()
  const out: Mention[] = []
  for (const s of segments(text)) {
    if (!('mention' in s)) continue
    const key = `${s.mention.path}::${s.mention.symbol ?? ''}`
    if (!seen.has(key)) { seen.add(key); out.push(s.mention) }
  }
  return out
}

/** How long an @query may grow while the menu stays open (a model's name has spaces: "claude opus 5.5"). */
export const MAX_QUERY_CHARS = 48

/** The @query being typed at the caret, or null: from an @ that opens a name — at the start, after whitespace, or
 *  after punctuation (a Chinese comma or full stop right before it, a colon, a bracket) — up to the caret, spaces
 *  allowed; never the @ inside a word (an e-mail) nor an agent chip already inserted. */
export function queryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = new RegExp(`${OPENER}@(?!\\[)([^@\\n]*)$`, 'u').exec(before)
  if (!m || m[2].length > MAX_QUERY_CHARS) return null
  return { start: caret - m[2].length - 1, query: m[2] }
}

/** The text with the @query at `start` replaced by the chosen entity's token (and a space). */
export function insertMention(text: string, start: number, caret: number, mention: Mention): { text: string; caret: number } {
  const token = `@${mention.path}${mention.symbol ? `::${mention.symbol}` : ''} `
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length }
}

/** The text with the @query at `start` replaced by the chosen agent's chip (and a space): a participant named again
 *  (`alias`: its id), or a new one — given an id of its own. */
export function insertAgent(text: string, start: number, caret: number, agent: { label: string; model: string; alias?: string | null }): { text: string; caret: number } {
  const alias = agent.alias ?? nextParticipantId(text)
  const token = `${agentMentionToken(agent.label, agent.model, alias)} `
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length }
}

/** The text with the @query at `start` replaced by the chosen tool's chip (and a space). */
export function insertTool(text: string, start: number, caret: number, tool: { id: MentionToolId; label: string }): { text: string; caret: number } {
  const token = `${toolMentionToken(tool.label, tool.id)} `
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length }
}

export function mentionLabel(m: Mention): string {
  const base = m.path.slice(m.path.lastIndexOf('/') + 1)
  return m.symbol ? `${base}::${m.symbol}` : base
}

const compact = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Whether a catalogue route answers an @query: the query's letters and digits, in order, are a run of the label's,
 *  the id's or the provider-and-label's ("claude opus 5.5", "gpt6 astra", "opus", "anthropic" all name a route). */
export function agentMatches(query: string, entry: { id: string; label: string; provider?: string }): boolean {
  const q = compact(query)
  if (!q) return true
  return compact(entry.label).includes(q) || compact(entry.id).includes(q) || compact(`${entry.provider ?? ''} ${entry.label}`).includes(q)
}

/** What an @query may also call a tool by, beside its label. */
const TOOL_WORDS: Record<MentionToolId, string[]> = { computer: ['computer use', 'browser', '电脑操控'] }

/** The tools the @ menu offers for a query, among those that work here (`available`): the query's letters and digits
 *  are a run of the tool's label or of a word it also goes by ("com", "computer use", "browser", "电脑"). */
export function toolsMatching(query: string, available: Partial<Record<MentionToolId, boolean>>): { id: MentionToolId; label: string }[] {
  const q = compact(query)
  return (Object.keys(MENTION_TOOLS) as MentionToolId[])
    .filter((id) => available[id] === true && [MENTION_TOOLS[id].label, ...TOOL_WORDS[id]].some((word) => compact(word).includes(q)))
    .map((id) => ({ id, label: MENTION_TOOLS[id].label }))
}
