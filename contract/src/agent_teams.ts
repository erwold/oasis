/** The desk's Agent Teams card (frontend components/AgentOutline.tsx), as the session shares carry it: one row per
 *  outline row — the session's runs folded into lineages by plan node (frontend state/lineage.ts foldLineages), action
 *  rows left out — with only what the card draws: a name, a bot NAME, a model's label, a status, the glyph's verdict,
 *  the participant's badge, how many runs, when it started and ended, and the tree's edges. Keys are share-local (`t1`,
 *  …; a run key `r3` of the same session for the turn a click scrolls to): never a run, session or participant id, a
 *  path, a receipt or a work order. The backend projects it (share/team.ts) with the pure functions below; the offline
 *  snapshot V3 and the live state v2 carry the same shape. */

import { z } from 'zod'
import { SHARE_BOTS } from './bots.ts'

const Key = z.string().regex(/^[a-z]{1,3}\d{1,6}$/)

export const SHARE_TEAM_KINDS = ['run', 'ask', 'plan', 'decision'] as const
export const SHARE_TEAM_STATUSES = ['queued', 'running', 'waiting', 'done', 'cancelled', 'error'] as const
export const SHARE_TEAM_GLYPHS = ['done', 'warn', 'bad', 'err'] as const
export type ShareTeamGlyph = (typeof SHARE_TEAM_GLYPHS)[number] | null

/** The bounds of one session's card. */
export const SHARE_TEAM_LIMITS = {
  /** rows of one session's card; past it the rest are left out and `truncated` says so */
  max_team_rows: 1_000,
  max_name_chars: 160,
  max_participant_label_chars: 80,
} as const

export const ShareTeamRowSchema = z.strictObject({
  key: Key,
  /** who it hangs under (the plan that scheduled it, else the run that dispatched it), as a row key; null: a root */
  parent: Key.nullable(),
  /** the rows that must end before it starts (a lineage carrying the run named), as row keys */
  depends_on: z.array(Key),
  kind: z.enum(SHARE_TEAM_KINDS),
  /** the outline's name (`Main agent`, the order's label, the first line), sanitized */
  name: z.string(),
  /** the bot the app's outline draws on the row (contract/src/bots.ts botOf), null for the person's decision */
  bot: z.enum(SHARE_BOTS).nullable(),
  /** the model's label; null: none (a decision) */
  model_label: z.string().nullable(),
  status: z.enum(SHARE_TEAM_STATUSES),
  /** what the row's end icon says (outline glyphFor): the verdict only, never the receipt it was read from */
  glyph: z.enum(SHARE_TEAM_GLYPHS).nullable(),
  /** the participant's place in its group (the badge shows index + 1) */
  participant_index: z.number().int().nonnegative().nullable(),
  participant_label: z.string().nullable(),
  /** runs the lineage holds */
  runs: z.number().int().positive(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  /** the run key (`r3`, of the same session's `runs`) of the lineage's latest run: the turn a click scrolls to; null
   *  for a plan's own rows and a run left out of the share */
  turn: Key.nullable(),
})
export type ShareTeamRow = z.infer<typeof ShareTeamRowSchema>

export const ShareTeamSchema = z.strictObject({
  rows: z.array(ShareTeamRowSchema),
  /** the desk's agents (folded by participant, action rows out): the card's "N agents" */
  agents: z.number().int().nonnegative(),
  /** rows queued or running */
  live: z.number().int().nonnegative(),
  truncated: z.boolean(),
})
export type ShareTeam = z.infer<typeof ShareTeamSchema>

// ---- the outline's pure readings, shared (frontend state/lineage.ts and state/outline.ts carry the same) -------------

/** What a tree row holds that the fold reads (RunTreeRow's fields). */
export interface TeamTreeRow {
  id: string
  session_id: string
  parent_run_id: string | null
  resumes_run_id: string | null
  spawned_by: string
  label: string | null
  model: string | null
  status: string
  created_at: string
  finished_at: string | null
  user_text: string
  user_text_head: string
  work_order: { label?: string | null } | null
  receipt: { interrupted?: boolean; mechanical?: { checks?: { failed?: number } | null; lock_violations?: number; failed_executions?: number } | null } | null
  plan_node_id: string | null
  participant_id: string | null
  participant_alias: string | null
  participant_index: number | null
  participant_name: string | null
  depends_on: string[]
  scheduled_by: string | null
  kind: string
  collab?: { participant_id: string | null; participant_role: string | null; placement: { group?: { kind: string; id: string } | null } } | null
}
export type TeamLineage<R extends TeamTreeRow = TeamTreeRow> = R & { lineage: R[]; latest: R }

/** foldLineages (frontend state/lineage.ts), unchanged: a row that resumes another joins that row's lineage; folded by
 *  the plan node, a plan node is a row of its own; folded by the participant, every run of one participant is one. */
export function foldTeamLineages<R extends TeamTreeRow>(rows: R[], by: 'plan_node_id' | 'participant_id' = 'plan_node_id'): TeamLineage<R>[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const own = (row: R): string | null => (by === 'participant_id' && row.collab?.participant_id ? `pa:${row.collab.participant_id}` : row[by])
  const keyOf = (row: R): string => {
    let cur = row
    const seen = new Set<string>()
    while (!own(cur) && cur.resumes_run_id && byId.has(cur.resumes_run_id) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.resumes_run_id)!
    }
    return own(cur) ?? cur.id
  }
  const groups = new Map<string, R[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const out: TeamLineage<R>[] = []
  const emitted = new Set<string>()
  for (const row of rows) {
    const key = keyOf(row)
    if (emitted.has(key)) continue
    emitted.add(key)
    const lineage = [...groups.get(key)!].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    const root = lineage[0]!
    const latest = lineage[lineage.length - 1]!
    out.push({ ...latest, id: root.id, parent_run_id: root.parent_run_id, spawned_by: root.spawned_by, created_at: root.created_at,
               label: root.label ?? latest.label, user_text: root.user_text, user_text_head: root.user_text_head,
               work_order: root.work_order, resumes_run_id: null, plan_node_id: root.plan_node_id, participant_id: root.participant_id,
               participant_alias: root.participant_alias, participant_index: root.participant_index, participant_name: root.participant_name, depends_on: root.depends_on, scheduled_by: root.scheduled_by, kind: root.kind, lineage, latest })
  }
  return out
}

/** withDependencies (frontend state/lineage.ts): a dependency on a run names the lineage that carries it. */
export function teamDependencies<R extends TeamTreeRow>(lineages: TeamLineage<R>[]): TeamLineage<R>[] {
  const rowOfRun = new Map<string, string>()
  for (const l of lineages) for (const r of l.lineage) rowOfRun.set(r.id, l.id)
  return lineages.map((l) => ({ ...l, depends_on: l.depends_on.map((id) => rowOfRun.get(id) ?? id) }))
}

/** outline parentOf: the plan that scheduled the row, else the run that dispatched it. */
export const teamParentOf = (row: { parent_run_id: string | null; scheduled_by?: string | null }): string | null => row.scheduled_by ?? row.parent_run_id

/** outline nameOf. */
export function teamNameOf(row: Pick<TeamTreeRow, 'label' | 'user_text_head' | 'id' | 'collab' | 'spawned_by' | 'work_order'>): string {
  if (row.collab?.participant_role === 'main') return 'Main agent'
  if (row.spawned_by === 'connector' && !row.work_order?.label) return row.user_text_head || row.label || row.id
  return row.label || row.user_text_head || row.id
}

/** outline glyphFor. */
export function teamGlyphOf(row: Pick<TeamTreeRow, 'status' | 'receipt'>): ShareTeamGlyph {
  if (row.status === 'error' || row.status === 'cancelled') return 'err'
  if (row.status !== 'done') return null
  const m = row.receipt?.mechanical
  if ((m?.checks?.failed ?? 0) > 0 || (m?.lock_violations ?? 0) > 0) return 'bad'
  return (m?.failed_executions ?? 0) > 0 ? 'warn' : 'done'
}

/** The glyph of an outline row as AgentOutline draws it: a run's from its receipt; a plan's own rows: an error is one,
 *  done is done, a stop is no failure (no glyph). */
export function teamRowGlyph(row: Pick<TeamTreeRow, 'status' | 'receipt' | 'kind'>): ShareTeamGlyph {
  if (row.kind === 'run') return teamGlyphOf(row)
  return row.status === 'error' ? 'err' : row.status === 'done' ? 'done' : null
}
