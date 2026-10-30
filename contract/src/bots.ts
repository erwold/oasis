/** The bots' identity, as pure functions (moved here from frontend/src/state/outline.ts so the app and the session
 *  shares compute one identity — see NOTICE for the outline's origin). The bot is never a role, and there is no lead: a
 *  participant of a relay or an interaction wears a bot picked by its own id; the session thread's own runs wear the
 *  bot a hash of the session id picks; every other run wears the one a hash of its own id picks, from the owner's set
 *  of twenty-nine; a director's plan row wears the director's own bot, the paper plane; a decision that is the
 *  person's wears none.
 *
 *  Every function here is the outline's, unchanged, except that the identity table is an argument (the app keeps its
 *  one table of the open session; the backend builds one per shared session from the real ids and exports only the
 *  bot NAMES it picks — never an id). */

import { CHATGPT_WEB_ID } from './models.ts'

export const BOTS = [
  '01-keycap', '02-terminal', '03-cursor', '04-braces', '05-bubble', '07-pixel', '08-prompt', '09-spark', '10-hex',
  '13-puzzle', '15-rocket', '16-lens', '17-shield', '18-robot', '19-chip', '20-at',
  '21-megaphone', '22-whistle', '23-signpost', '24-badge', '25-compass', '26-crownblob', '27-crown', '28-flag', '29-lighthouse', '30-telescope',
  '31-pin', '32-helm', '33-bell',
] as const

/** The director's bot, on its plan row. */
export const DIRECTOR_BOT = 'director' as const
/** ChatGPT on the web is no bot of this harness: it wears ChatGPT's own mark, still in every state. */
export const CHATGPT_BOT = 'chatgpt' as const
/** Every bot a share may name: the product's set, the director's paper plane, ChatGPT's mark — nothing else. */
export const SHARE_BOTS = [...BOTS, DIRECTOR_BOT, CHATGPT_BOT] as const
export type ShareBot = (typeof SHARE_BOTS)[number]

/** FNV-1a, 32 bits, over UTF-16 code units (the outline's hash, byte for byte). */
export function hashOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** Each bot's colour (the alpha-weighted mean of its icon): the outline's elbows and the cards' light. */
export const BOT_HEX: Record<string, string> = {
  '01-keycap': '#EDE8E1', '02-terminal': '#304976', '03-cursor': '#04050B', '04-braces': '#416CB7', '05-bubble': '#C7C8D3',
  '07-pixel': '#B0E7BB', '08-prompt': '#0EBB73', '09-spark': '#F37C52', '10-hex': '#474B5A',
  '13-puzzle': '#B189F7', '15-rocket': '#F3C8C9',
  '16-lens': '#0E627A', '17-shield': '#9499CB', '18-robot': '#B6B5C3', '19-chip': '#545763', '20-at': '#F65A63',
  '21-megaphone': '#9DB3DA', '22-whistle': '#F4871F', '23-signpost': '#F1C341', '24-badge': '#9391F0', '25-compass': '#66CDC2',
  '26-crownblob': '#ED625D', '27-crown': '#F3BC16', '28-flag': '#C73D45', '29-lighthouse': '#91CBB2', '30-telescope': '#345898',
  '31-pin': '#F59DA3', '32-helm': '#338599', '33-bell': '#F0BB29',
  director: '#43A0F9', chatgpt: '#10A37F',
}

/** A bot's colour family: its hue in twelve steps, or neutral (greys, near black, near white), so participants side
 *  by side can be kept apart by colour, not only by shape. */
export function colourFamily(bot: string): string {
  const hex = BOT_HEX[bot]
  if (!hex) return 'none'
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (s < 0.2 || l < 0.12 || l > 0.92) return 'neutral'
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return `hue-${Math.floor((h * 60) / 30) % 12}`
}

// ---- identity: one bot per participant, wherever it is shown -------------------------------------------------------

/** The bots of a session's participants by their stable ids (schema v25: `collab.participant_id`), and by their group
 *  handle (`interaction:<id>:<alias>`, `relay:<id>:<alias>`) for the views that know a step by its alias. */
export interface BotIdentityTable { sessionId: string | null; byParticipant: Map<string, string>; byMember: Map<string, string> }
export const EMPTY_BOT_TABLE: BotIdentityTable = Object.freeze({ sessionId: null, byParticipant: new Map<string, string>(), byMember: new Map<string, string>() })

/** What identityTable reads of a tree row (RunTreeRow's fields). */
export interface BotIdentityRow {
  id: string
  session_id: string
  created_at: string
  participant_alias?: string | null
  participant_index?: number | null
  participant_id?: string | null
  /** the run's collab as the tree carries it (an older row: none; a field the harness did not name: null — skipped) */
  collab?: { participant_id: string | null; participant_role: string | null; placement: { group?: { kind: string; id: string } | null } } | null
}

/** The table for a session's rows: its participants (other than the main agent) in the order they first ran — ties of
 *  one moment by their place in their group, then by id — each a bot of the pool picked by its own id: never the main
 *  agent's nor one an earlier participant wears, and of a colour family none of them wears while one is left. A
 *  participant that joins later never moves an earlier one's bot. */
export function identityTable(rows: readonly BotIdentityRow[], sessionId: string): BotIdentityTable {
  const first = new Map<string, { at: string; place: number }>()
  const handles = new Map<string, Set<string>>()
  for (const r of rows) {
    const c = r.collab
    if (!c?.participant_id || c.participant_role === 'main') continue
    const held = first.get(c.participant_id)
    const place = r.participant_index ?? Number.MAX_SAFE_INTEGER
    if (!held || r.created_at < held.at) first.set(c.participant_id, { at: r.created_at, place })
    const group = c.placement.group ? `${c.placement.group.kind}:${c.placement.group.id}` : null
    if (group && r.participant_alias) {
      const mine = handles.get(c.participant_id) ?? new Set<string>()
      mine.add(`${group}:${r.participant_alias}`)
      handles.set(c.participant_id, mine)
    }
  }
  const order = [...first.entries()].sort(([a, x], [b, y]) => x.at.localeCompare(y.at) || x.place - y.place || a.localeCompare(b))
  const byParticipant = participantBots(sessionId, order.map(([pid]) => pid)), byMember = new Map<string, string>()
  for (const [pid, bot] of byParticipant) for (const handle of handles.get(pid) ?? []) if (!byMember.has(handle)) byMember.set(handle, bot)
  return { sessionId, byParticipant, byMember }
}

/** The session's main agent's bot: picked by the session. */
export const mainBot = (sessionId: string): string => BOTS[hashOf(`session:${sessionId}`) % BOTS.length]!

/** The bots of a session's participants other than the main agent, in the order they first ran. */
export function participantBots(sessionId: string, ordered: readonly string[]): Map<string, string> {
  const main = mainBot(sessionId)
  const worn = new Set<string>([main]), families = new Set<string>([colourFamily(main)])
  const out = new Map<string, string>()
  for (const pid of ordered) {
    const free = BOTS.filter((b) => !worn.has(b))
    const apart = free.filter((b) => !families.has(colourFamily(b)))
    // the pool is shared again only once every bot is worn
    const from = apart.length ? apart : free.length ? free : [...BOTS]
    const bot = [...from].sort((a, b) => hashOf(`${pid}:${a}`) - hashOf(`${pid}:${b}`) || a.localeCompare(b))[0]!
    worn.add(bot)
    families.add(colourFamily(bot))
    out.set(pid, bot)
  }
  return out
}

/** Who has taken part in a session (contract SessionActivity's agents). */
export interface BotSessionAgent { kind: 'main' | 'participant' | 'chatgpt' | 'director'; participant_id: string | null; model: string | null }

/** The rail's bots of a session: the main agent first, then the others as they joined. None known: the main agent's. */
export function sessionBots(sessionId: string, agents: readonly BotSessionAgent[] | undefined): string[] {
  const list = agents ?? []
  const others = participantBots(sessionId, list.flatMap((a) => (a.kind === 'participant' && a.participant_id && a.model !== CHATGPT_WEB_ID ? [a.participant_id] : [])))
  const bots = list.map((a) => a.kind === 'main' ? mainBot(sessionId) : a.kind === 'director' ? DIRECTOR_BOT
    : a.kind === 'chatgpt' || a.model === CHATGPT_WEB_ID ? CHATGPT_BOT : others.get(a.participant_id ?? '') ?? null)
  const unique = [...new Set(bots.filter((b): b is string => b !== null))]
  return unique.length ? unique : [mainBot(sessionId)]
}

/** A participant's bot by its stable id, or null when the harness names none (the caller then falls back). */
export function participantBotOf(table: BotIdentityTable, participantId: string | null | undefined, model?: string | null): string | null {
  if (model === CHATGPT_WEB_ID) return CHATGPT_BOT
  return participantId ? table.byParticipant.get(participantId) ?? null : null
}

/** A group member's bot by its group and alias: its stable participant's when the harness names one, else one picked
 *  by its handle in the group. */
export function memberBotOf(table: BotIdentityTable, group: { kind: 'interaction' | 'relay'; id: string }, alias: string, model?: string | null): string | null {
  if (model === CHATGPT_WEB_ID) return CHATGPT_BOT
  const handle = `${group.kind}:${group.id}:${alias}`
  return table.byMember.get(handle) ?? BOTS[hashOf(handle) % BOTS.length]!
}

/** What botOf reads of a row (RunTreeRow's fields; a folded lineage row is one). */
export interface BotRow {
  id: string
  session_id: string
  model: string | null
  spawned_by: string
  parent_run_id: string | null
  work_order: unknown
  kind?: string
  participant_id?: string | null
  collab?: { participant_id?: string | null; participant_role?: string | null } | null
}

/** The bot a run wears; a person's own action (no model) and the person's decision wear none. */
export function botOf(row: BotRow, table: BotIdentityTable): string | null {
  if (row.kind === 'decision') return null
  if (row.kind === 'plan') return DIRECTOR_BOT
  if (!row.model || row.spawned_by === 'human_action') return null
  if (row.model === CHATGPT_WEB_ID) return CHATGPT_BOT
  const c = row.collab
  if (c?.participant_role === 'main') return BOTS[hashOf(`session:${row.session_id}`) % BOTS.length]!
  const stable = participantBotOf(table, c?.participant_id, row.model)
  if (stable) return stable
  return BOTS[hashOf(identityKey(row)) % BOTS.length]!
}

/** What a run's bot is keyed by when it has no place in a group. */
export function identityKey(row: Pick<BotRow, 'id' | 'session_id' | 'parent_run_id' | 'work_order' | 'collab' | 'participant_id'>): string {
  const c = row.collab
  if (c?.participant_role === 'main') return `session:${row.session_id}`
  if (c?.participant_id) return `participant:${c.participant_id}`
  if (row.participant_id) return `participant:${row.participant_id}`
  return !row.parent_run_id && !row.work_order ? `session:${row.session_id}` : row.id
}

/** The bot a run's turn wears in the thread and whether its part is enclosed in the bot's colour (ThreadTranscript's
 *  turnFace). `relay` / `interaction`: the group turn the run is (its group's id and the participant's alias there);
 *  `continues`: the interaction participant a run of its own continues (a follow-up resuming one). */
export function turnFaceOf(table: BotIdentityTable,
  run: { id: string; session_id: string; model: string | null; spawned_by: string; parent_run_id: string | null; collab?: BotRow['collab'] },
  relay: { relay_id: string; alias: string } | null, interaction: { interaction_id: string; alias: string } | null,
  continues: { interaction_id: string; alias: string } | null): { bot: string | null; enclosed: boolean } {
  const stable = run.collab && run.collab.participant_role !== 'main' ? participantBotOf(table, run.collab.participant_id, run.model) : null
  const groupBot = interaction ? memberBotOf(table, { kind: 'interaction', id: interaction.interaction_id }, interaction.alias, run.model)
    : relay ? memberBotOf(table, { kind: 'relay', id: relay.relay_id }, relay.alias, run.model)
    : continues ? memberBotOf(table, { kind: 'interaction', id: continues.interaction_id }, continues.alias, run.model) : null
  const bot = stable ?? groupBot ?? botOf({ id: run.id, session_id: run.session_id, model: run.model, spawned_by: run.spawned_by, parent_run_id: run.parent_run_id, work_order: null, collab: run.collab }, table)
  return { bot, enclosed: groupBot !== null || stable !== null }
}
