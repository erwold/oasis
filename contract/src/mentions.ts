/** An agent named in the person's message. The composer inserts a chip; the message carries it as a token both
 *  ends parse the same way — `@[Claude Opus 5.5](agent:anthropic:claude-opus-5-5#pt_3f2a9c)`: the label the person
 *  saw, the model route's id (the harness's own stable handle, never a display name) and, after `#`, the
 *  participant's id in this message — a string like the harness's other ids (`pt_3f2a9c`) — so two participants on
 *  the same model are two, and the same participant named twice is one. Messages written earlier name participants
 *  by a letter (`#A`), still read as their ids; a token with no id at all names a participant of its own at each
 *  occurrence. A file mention (`@path`) is the workspace entities' business and stays as it was. */

/** A token's participant: `alias` is the participant's id in the message (the name the field kept from the letters). */
export interface AgentMention { label: string; model: string; alias: string | null }

/** A participant of a message: its id (what the turns and the plans name it by), its label and its model route. */
export interface MentionedParticipant { id: string; label: string; model: string }

/** What a participant's id may be: `pt_3f2a9c`, or an earlier message's letter. */
export const PARTICIPANT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/

const TOKEN = /@\[([^\]\n]{1,120})\]\(agent:([^)\s#]{1,200})(?:#([A-Za-z][A-Za-z0-9_-]{0,39}))?\)/g

export function agentMentionToken(label: string, model: string, alias: string | null = null): string {
  return `@[${label.replace(/[[\]\n]/g, ' ').trim()}](agent:${model}${alias ? `#${alias}` : ''})`
}

/** The agents a message names, in order of appearance, every occurrence (a participant named twice is two entries). */
export function agentMentionsOf(text: string): AgentMention[] {
  const out: AgentMention[] = []
  for (const m of text.matchAll(TOKEN)) out.push({ label: m[1]!, model: m[2]!, alias: m[3] ?? null })
  return out
}

/** The letter an earlier message's n-th participant was named by (0-based): A, B, … — for tokens without an id. */
export function participantAlias(index: number): string {
  return String.fromCharCode(65 + index)
}

/** A new participant's id, none of `taken`: `pt_` and six hex digits, as the harness's other ids read. */
export function newParticipantId(taken: Iterable<string> = []): string {
  const used = new Set(taken)
  for (;;) {
    const bytes = new Uint8Array(3)
    globalThis.crypto.getRandomValues(bytes)
    const id = `pt_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
    if (!used.has(id)) return id
  }
}

/** The names a person reads for a message's participants: the label, unless two share it — then each is its own id
 *  (`pt_3f2a9c`, `pt_8c1d4e`), the one unique thing it has; its model is said beside it where the model is shown. */
export function participantNames(participants: { id: string; label: string }[]): Map<string, string> {
  const count = new Map<string, number>()
  for (const p of participants) count.set(p.label, (count.get(p.label) ?? 0) + 1)
  return new Map(participants.map((p) => [p.id, (count.get(p.label) ?? 0) > 1 ? p.id : p.label]))
}

/** The alias of every occurrence, in order: an aliased token's own; a token without one gets the first alias no
 *  participant of the message holds (so a message written before aliases existed names a participant per token). */
function occurrenceAliases(mentions: AgentMention[]): string[] {
  const taken = new Set(mentions.map((m) => m.alias).filter((a): a is string => a !== null))
  let next = 0
  return mentions.map((m) => {
    if (m.alias !== null) return m.alias
    for (;;) {
      const alias = participantAlias(next)
      next += 1
      if (!taken.has(alias)) { taken.add(alias); return alias }
    }
  })
}

/** The participants a message names, in order of first appearance: an aliased token names the participant of its
 *  alias (named again, it is the same one); a token without an alias is a participant of its own at each occurrence. */
export function participantsOf(text: string): MentionedParticipant[] {
  const mentions = agentMentionsOf(text)
  const aliases = occurrenceAliases(mentions)
  const out: MentionedParticipant[] = []
  mentions.forEach((m, i) => {
    const id = aliases[i]!
    if (!out.some((p) => p.id === id)) out.push({ id, label: m.label, model: m.model })
  })
  return out
}

/** The id a participant added to `text` gets: a new one, none of the message's. */
export function nextParticipantId(text: string): string {
  return newParticipantId(participantsOf(text).map((p) => p.id))
}

/** A tool named in the person's message. The composer inserts a chip; the message carries it as a token —
 *  `@[Computer](tool:computer)`: the label the person saw and the tool's id here (`MENTION_TOOLS`), which stands for
 *  the agent tools it names. The chip says which tools the person asked for; it grants nothing — the tools stay under
 *  the session's permissions as they are. */
export const MENTION_TOOLS = {
  computer: { label: 'Computer', tools: ['computer_observe', 'computer_act'] },
} as const satisfies Record<string, { label: string; tools: readonly string[] }>
export type MentionToolId = keyof typeof MENTION_TOOLS

export interface ToolMention { label: string; tool: string }

const TOOL_TOKEN = /@\[([^\]\n]{1,120})\]\(tool:([a-z][a-z0-9_-]{0,39})\)/g

const isMentionTool = (id: string): id is MentionToolId => Object.hasOwn(MENTION_TOOLS, id)

export function toolMentionToken(label: string, tool: string): string {
  return `@[${label.replace(/[[\]\n]/g, ' ').trim()}](tool:${tool})`
}

/** The tools a message names, in order of appearance, every occurrence. */
export function toolMentionsOf(text: string): ToolMention[] {
  const out: ToolMention[] = []
  for (const m of text.matchAll(TOOL_TOKEN)) out.push({ label: m[1]!, tool: m[2]! })
  return out
}

/** The tools a message names that exist here, once each, in order: the chip's label and the agent tools it stands for
 *  (a token whose id is not one of `MENTION_TOOLS` names nothing). */
export function namedTools(text: string): { id: MentionToolId; label: string; tools: readonly string[] }[] {
  const out: { id: MentionToolId; label: string; tools: readonly string[] }[] = []
  for (const m of toolMentionsOf(text)) {
    if (isMentionTool(m.tool) && !out.some((t) => t.id === m.tool)) out.push({ id: m.tool, label: m.label, tools: MENTION_TOOLS[m.tool].tools })
  }
  return out
}

/** The text with every tool token as `@Label`: words that are not the person's (another agent's answer) name no tool. */
export const plainToolMentions = (text: string): string => text.replace(TOOL_TOKEN, (_m, label: string) => `@${label}`)

/** The message as a person (or a plain listing) reads it: every token — an agent's, a tool's — as `@Label`. */
export function plainAgentMentions(text: string): string {
  return plainToolMentions(text.replace(TOKEN, (_m, label: string) => `@${label}`))
}

/** The message as a chat client's director reads it (ChatGPT, typed into its page): every agent token as
 *  `@Label (route)` — the name the person saw and the route start_run takes; a tool's as `@Label`. */
export function routedAgentMentions(text: string): string {
  return plainToolMentions(text.replace(TOKEN, (_m, label: string, model: string) => `@${label} (${model})`))
}

/** The message as a model reads it beside a roster: with two or more participants every agent token is `@<id>` — the
 *  id the roster explains, unambiguous when two participants share a model; with one participant, `@Label`. A tool's
 *  token is `@Label` either way. */
export function aliasedAgentMentions(text: string): string {
  const mentions = agentMentionsOf(text)
  const aliases = occurrenceAliases(mentions)
  if (new Set(aliases).size < 2) return plainAgentMentions(text)
  let i = 0
  return plainToolMentions(text.replace(TOKEN, () => `@${aliases[i++]}`))
}

/** The text split into plain runs and agent mentions, in order (the thread draws the mentions as chips). */
export type AgentSegment = { text: string } | { agent: AgentMention; raw: string }

export function agentSegments(text: string): AgentSegment[] {
  const out: AgentSegment[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ agent: { label: m[1]!, model: m[2]!, alias: m[3] ?? null }, raw: m[0] })
    last = start + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** The text split into plain runs, agent mentions and tool mentions, in order (the composer and the thread draw the
 *  mentions as chips). */
export type MentionSegment = AgentSegment | { tool: ToolMention; raw: string }

export function mentionSegments(text: string): MentionSegment[] {
  const out: MentionSegment[] = []
  for (const piece of agentSegments(text)) {
    if ('agent' in piece) { out.push(piece); continue }
    let last = 0
    for (const m of piece.text.matchAll(TOOL_TOKEN)) {
      const start = m.index ?? 0
      if (start > last) out.push({ text: piece.text.slice(last, start) })
      out.push({ tool: { label: m[1]!, tool: m[2]! }, raw: m[0] })
      last = start + m[0].length
    }
    if (last < piece.text.length) out.push({ text: piece.text.slice(last) })
  }
  return out
}
