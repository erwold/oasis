/** A share's Agent Teams card as the outline takes it (components/OutlineView.tsx): the team the snapshot carries
 *  (contract agent_teams.ts — the backend's projection of the app's outline rows: names, bot names, model labels,
 *  statuses, the glyph's verdict, the tree's edges, share-local keys) read into the outline's rows. Nothing is
 *  recomputed from ids the share does not carry: the bot is the row's, the tree is its `parent` and `depends_on`. Pure:
 *  node --test exercises it. */

import type { ShareRunV3, ShareTeam, ShareTeamRow, LiveRunV2 } from '@oasis-code/contract'
import type { OutlineItem } from '../components/OutlineView.tsx'
import type { BotState, Glyph } from '../state/outline.ts'
import type { ShareFace } from './document.ts'

const GLYPH_TITLE: Record<Exclude<Glyph, null>, string> = {
  done: 'Done',
  warn: 'Done · some commands exited with an error',
  bad: 'Done · a check failed or a locked file changed',
  err: 'Ended in an error',
}

function glyphTitle(row: ShareTeamRow): string {
  if (!row.glyph) return ''
  if (row.glyph === 'err' && row.status === 'cancelled') return 'Stopped'
  return GLYPH_TITLE[row.glyph]
}

/** One team row as the outline draws it. */
export function teamItem(row: ShareTeamRow): OutlineItem {
  return {
    id: row.key, parent_run_id: row.parent, scheduled_by: null, depends_on: row.depends_on, kind: row.kind, status: row.status, bot: row.bot,
    name: row.name, model: row.model_label, participant_index: row.participant_index, participant_name: row.participant_label, participant_alias: null,
    runs: row.runs, created_at: row.started_at, finished_at: row.finished_at, glyph: row.glyph, glyph_title: glyphTitle(row),
    // the share carries no id to show, and no lock: a queued row is only queued
    ref: null, lock: null,
  }
}

/** The team's rows as the outline draws them, in the team's order; a row naming a parent or a dependency the team
 *  does not hold hangs at the root (buildTree) and waits on nothing it cannot name. */
export function teamItems(team: ShareTeam): OutlineItem[] {
  const keys = new Set(team.rows.map((r) => r.key))
  return team.rows.map((r) => {
    const item = teamItem(r)
    return { ...item, parent_run_id: item.parent_run_id !== null && keys.has(item.parent_run_id) ? item.parent_run_id : null, depends_on: item.depends_on.filter((k) => keys.has(k)) }
  })
}

/** A share's row's bot state, from its status alone (a share draws still bots: its state only says which rows work —
 *  the outline's breathing dot — never an animation to load). */
export function teamRowState(row: Pick<OutlineItem, 'status'>): BotState {
  switch (row.status) {
    case 'queued': return 'waiting'
    case 'waiting': return 'idle'
    case 'running': return 'thinking'
    default: return 'static'
  }
}

/** The faces of a session's turns, as the backend computed them (contract bots.ts turnFaceOf), by run key. */
export function runFaces(runs: readonly (ShareRunV3 | LiveRunV2)[]): Record<string, ShareFace> {
  return Object.fromEntries(runs.map((r) => [r.key, { bot: r.bot, enclosed: r.enclosed }]))
}

/** The session a share shows: the one chosen while the share still holds it (a live task's session deleted, its
 *  choice goes), else the one it opens on, else its first. */
export function shownSession(sessions: readonly { key: string }[], chosen: string | null, start: string | null): string | null {
  if (chosen && sessions.some((s) => s.key === chosen)) return chosen
  if (start && sessions.some((s) => s.key === start)) return start
  return sessions[0]?.key ?? null
}
