/** What the session shares of V3 (offline) and v2 (live) add to a session's projection: the desk's Agent Teams card
 *  (contract/src/agent_teams.ts), the face each run's turn wears (ThreadTranscript turnFace), and the rail's bots of the
 *  session — every bot computed HERE from the real ids with the contract's one identity (contract/src/bots.ts), and
 *  only its NAME exported. The card's rows are the outline's: the same rows GET /api/sessions/:id/runs/tree answers
 *  (treeRow + collab + planRows), runs left out of the share removed, folded by plan node (foldTeamLineages, as
 *  AgentOutline folds), action rows out; each field whitelisted and its strings through the projection's sanitizer. */

import {
  botOf, identityTable, participantBotOf, sessionBots, SHARE_BOTS, SHARE_TEAM_LIMITS, foldTeamLineages, teamDependencies, teamNameOf, teamParentOf, teamRowGlyph,
  turnFaceOf, type BotIdentityTable, type CollaborationGraph, type Interaction, type Relay, type Run, type RunCollab, type ShareTeam, type ShareTeamRow, type TeamTreeRow,
} from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { getDirectorSession } from '../director/store.ts'
import { treeRow } from '../api/common.ts'
import { planRows, stampDepths, type InteractionRows, type PlanRowNaming } from '../api/tree.ts'
import { isGeneratedParticipantId, shareParticipantNames } from './names.ts'
import { sessionAgentsOf } from '../api/session_activity.ts'

const BOT_NAMES = new Set<string>(SHARE_BOTS)
const botName = (b: string | null): (typeof SHARE_BOTS)[number] | null => (b !== null && BOT_NAMES.has(b) ? b as (typeof SHARE_BOTS)[number] : null)
const TEAM_STATUSES = new Set(['queued', 'running', 'waiting', 'done', 'cancelled', 'error'])
const TEAM_KINDS = new Set(['run', 'ask', 'plan', 'decision'])

export interface TeamInput {
  conn: Conn
  session_id: string
  runs: Run[]
  graph: CollaborationGraph
  relays: Relay[]
  interactions: Interaction[]
  /** runs left out of the share */
  excluded: ReadonlySet<string>
  /** the share's run key of a run (null: not in the share) */
  runKey: (runId: string) => string | null
  /** a run's status as the projection says it (live: a watched run's handle) */
  statusOf: (run: Run) => string
  label: (text: string, max: number) => string
  modelLabel: (model: string | null) => string
  /** live: the producer's keys of the card's rows (a row's root id → its key), kept across states; absent: positional */
  rowKeys?: Map<string, string>
}

export interface TeamOutput {
  team: ShareTeam
  /** the face of each run in the share, by run id */
  faces: Map<string, { bot: (typeof SHARE_BOTS)[number] | null; enclosed: boolean }>
  /** the rail's bots of the session */
  bots: (typeof SHARE_BOTS)[number][]
}

/** The plan rows' names in a share: a participant by its share name (share/names.ts: never a harness-generated id),
 *  the decision's candidates the same — the app's own rows (api/sessions.ts) keep APP_PLAN_NAMING. */
const SHARE_PLAN_NAMING: PlanRowNaming = { names: shareParticipantNames, candidate: (id, names) => names.get(id) ?? (isGeneratedParticipantId(id) ? 'a participant' : id) }

/** The outline's tree rows of a session (api/sessions.ts runs/tree, without the runner's liveness), named for a share. */
export function treeRowsOf(input: Pick<TeamInput, 'conn' | 'session_id' | 'runs' | 'graph' | 'relays' | 'interactions' | 'statusOf'>): TeamTreeRow[] {
  const collab = new Map<string, RunCollab>(input.graph.runs.map((r) => [r.id, r.collab]))
  const runs = input.runs.map((run) => ({ ...treeRow(run), status: input.statusOf(run), collab: collab.get(run.id) ?? null }))
  const interactions: InteractionRows[] = input.interactions.map((interaction) => ({
    interaction, nodes: repo.listNodes(input.conn, interaction.id),
    director_model: interaction.director_session_id ? getDirectorSession(input.conn, interaction.director_session_id)?.model ?? null : null,
    adopted: repo.listInteractionEvents(input.conn, interaction.id).some((e) => e.kind === 'adopted'),
  }))
  const rows = planRows(runs, input.relays, interactions, SHARE_PLAN_NAMING)
  stampDepths(rows)
  return rows as unknown as TeamTreeRow[]
}

export function projectTeam(input: TeamInput): TeamOutput {
  const all = treeRowsOf(input)
  // the identity table of every row of the session (the app's: identityTable over the tree it read)
  const table: BotIdentityTable = identityTable(all as Parameters<typeof identityTable>[0], input.session_id)
  const faces = facesOf(input, table, new Map(all.map((r) => [r.id, r])))
  const bots = sessionBots(input.session_id, sessionAgentsOf(input.conn, input.session_id)).map(botName).filter((b): b is NonNullable<typeof b> => b !== null)

  // the card: folded over the WHOLE tree (as the app folds it), so a row's identity — its bot, its parent, what it
  // waits for — is the app's whatever is left out; a run left out only leaves its lineage (a lineage left with no run
  // goes; one whose first run is left out is named and timed by its first run shown)
  const lineages = teamDependencies(foldTeamLineages(all)).filter((l) => l.spawned_by !== 'human_action')
  const visible = lineages.flatMap((l) => {
    const kept = l.lineage.filter((r) => !input.excluded.has(r.id))
    return kept.length ? [{ l, kept }] : []
  })
  const agents = foldTeamLineages(all.filter((r) => r.spawned_by !== 'plan'), 'participant_id')
    .filter((l) => l.spawned_by !== 'human_action' && l.lineage.some((r) => !input.excluded.has(r.id))).length
  const limited = visible.slice(0, SHARE_TEAM_LIMITS.max_team_rows)
  const keys = input.rowKeys ?? new Map<string, string>()
  let next = Math.max(0, ...[...keys.values()].map((k) => Number(k.slice(1)) || 0)) + 1
  const keyOf = new Map<string, string>()
  for (const { l } of limited) {
    let k = keys.get(l.id)
    if (k === undefined) { k = `t${next++}`; keys.set(l.id, k) }
    keyOf.set(l.id, k)
  }
  const rows: ShareTeamRow[] = limited.map(({ l, kept }) => {
    const whole = kept.length === l.lineage.length
    const first = kept[0]!, last = kept[kept.length - 1]!
    const parent = teamParentOf(l)
    const name = whole ? teamNameOf(l)
      : teamNameOf({ id: l.id, label: first.label ?? last.label, user_text_head: first.user_text_head, collab: last.collab ?? null, spawned_by: first.spawned_by, work_order: first.work_order })
    // the outline's last fallback is the row's id: never exported
    const shownName = name === l.id || name === '' ? 'Agent' : input.label(name, SHARE_TEAM_LIMITS.max_name_chars) || 'Agent'
    const latest = whole ? l.latest : last
    const latestRun = latest.spawned_by === 'plan' ? null : latest.id
    const status = whole ? l.status : last.status
    return {
      key: keyOf.get(l.id)!,
      parent: parent !== null ? keyOf.get(parent) ?? null : null,
      depends_on: l.depends_on.map((d) => keyOf.get(d)).filter((k): k is string => k !== undefined),
      kind: (TEAM_KINDS.has(l.kind) ? l.kind : 'run') as ShareTeamRow['kind'],
      name: shownName,
      // the bot of the row the app's outline draws (the whole tree's fold, the whole tree's identity table)
      bot: botName(botOf(l as Parameters<typeof botOf>[0], table)),
      model_label: latest.model ? input.modelLabel(latest.model) : null,
      status: (TEAM_STATUSES.has(status) ? status : 'error') as ShareTeamRow['status'],
      glyph: teamRowGlyph({ kind: l.kind, status, receipt: latest.receipt }),
      participant_index: typeof l.participant_index === 'number' && l.participant_index >= 0 ? l.participant_index : null,
      participant_label: l.participant_name ? input.label(l.participant_name, SHARE_TEAM_LIMITS.max_participant_label_chars) : null,
      runs: kept.length,
      started_at: whole ? l.created_at : first.created_at,
      finished_at: latest.finished_at,
      turn: latestRun !== null ? input.runKey(latestRun) : null,
    }
  })
  const team: ShareTeam = { rows, agents, live: rows.filter((r) => r.status === 'queued' || r.status === 'running').length, truncated: visible.length > limited.length }
  return { team, faces, bots }
}

/** Each run's face as the app's share export reads it (frontend components/shareExport.ts shareLook): a run of the
 *  thread (placement `thread`) wears its turn's face (turnFace: its stable participant's bot, else its group member's,
 *  else the one botFor gives it), a follow-up continuing an interaction participant — along the thread runs' resume
 *  chain — that participant's; any other run the bot its outline row wears, enclosed when its participant is named. */
function facesOf(input: TeamInput, table: BotIdentityTable, treeById: ReadonlyMap<string, TeamTreeRow>): TeamOutput['faces'] {
  const collab = new Map<string, RunCollab>(input.graph.runs.map((r) => [r.id, r.collab]))
  const relays = new Map(input.relays.map((r) => [r.id, r]))
  const nodesOf = new Map<string, ReturnType<typeof repo.listNodes>>()
  const nodes = (id: string) => { let n = nodesOf.get(id); if (n === undefined) { n = repo.listNodes(input.conn, id); nodesOf.set(id, n) } return n }
  const interactions = new Map(input.interactions.map((x) => [x.id, x]))
  const interactionTurn = (run: Pick<Run, 'interaction_id' | 'interaction_node'>): { interaction_id: string; alias: string } | null => {
    if (!run.interaction_id || !run.interaction_node) return null
    const ix = interactions.get(run.interaction_id)
    if (!ix) return null
    const node = nodes(ix.id).find((n) => n.id === run.interaction_node)
    if (!node) return null
    const participant = ix.participants.find((p) => p.id === node.participant)
    return participant ? { interaction_id: ix.id, alias: node.participant } : null
  }
  const relayTurn = (run: Pick<Run, 'relay_id' | 'relay_step'>): { relay_id: string; alias: string } | null => {
    if (!run.relay_id || run.relay_step === null || run.relay_step === undefined) return null
    const relay = relays.get(run.relay_id)
    if (!relay) return null
    const step = relay.steps.find((s) => s.seq === run.relay_step) ?? relay.steps[run.relay_step]
    if (!step || !relay.participants[step.participant]) return null
    return { relay_id: relay.id, alias: relay.participants[step.participant]?.id || String.fromCharCode(65 + step.participant) }
  }
  const thread = input.runs.filter((r) => collab.get(r.id)?.placement.surface === 'thread')
  const threadById = new Map(thread.map((r) => [r.id, r]))
  const continues = (run: Run): { interaction_id: string; alias: string } | null => {
    if (run.interaction_id && run.interaction_node) return null
    const seen = new Set<string>()
    let cur = run.resumes_run_id ? threadById.get(run.resumes_run_id) : undefined
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      const turn = interactionTurn(cur)
      if (turn) return turn
      cur = cur.resumes_run_id ? threadById.get(cur.resumes_run_id) : undefined
    }
    return null
  }
  const out: TeamOutput['faces'] = new Map()
  for (const run of input.runs) {
    if (input.excluded.has(run.id)) continue
    const c = collab.get(run.id) ?? null
    if (threadById.has(run.id)) {
      const face = turnFaceOf(table, { id: run.id, session_id: run.session_id, model: run.model || null, spawned_by: run.spawned_by, parent_run_id: run.parent_run_id, collab: c },
        relayTurn(run), interactionTurn(run), continues(run))
      out.set(run.id, { bot: botName(face.bot), enclosed: face.enclosed })
      continue
    }
    // the run's own tree row (the plan's decorations on it included), as the app's shareLook reads s.tree
    const row = treeById.get(run.id)
    if (row === undefined) { out.set(run.id, { bot: null, enclosed: false }); continue }
    const stable = row.collab && row.collab.participant_role !== 'main' ? participantBotOf(table, row.collab.participant_id, row.model) : null
    const bot = botOf(row as Parameters<typeof botOf>[0], table)
    out.set(run.id, { bot: botName(bot), enclosed: stable !== null })
  }
  return out
}
