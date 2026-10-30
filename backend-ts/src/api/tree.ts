import { participantNames, plainAgentMentions, type Interaction, type InteractionNode, type Relay } from '@oasis-code/contract'

/** The outline's rows beyond the runs (the owner's Agent Teams hand-off, 2026-09-29): one row per plan node. A relay's
 *  step and an interaction's node that have a run decorate that run's row with the node's id, its participant (a
 *  stable instance: the letter, never renumbered; two may run one model), the rows it waits for and who scheduled
 *  it. A node without a run yet is a placeholder row (`spawned_by: plan`, queued, never live, the node's id as its
 *  own). A director's plan is a row its nodes hang under (`scheduled_by`), asleep while they run. A plan that ends
 *  on the person closes with a decision row: queued until the last steps end, then the person's. Everything here is
 *  read from what the harness persisted; nothing is derived from a model's words. */
export type TreeRow = Record<string, unknown>

export interface InteractionRows {
  interaction: Interaction
  nodes: InteractionNode[]
  /** the director's model, for its plan row */
  director_model: string | null
  /** whether the person kept a step's result already: the decision row reads done then */
  adopted: boolean
}

const headOf = (text: string): string => {
  const trimmed = plainAgentMentions(text).trim()
  return trimmed ? trimmed.split(/\r?\n/)[0]!.slice(0, 160) : ''
}

/** A plan's own row: never a run (no receipt, never live), scheduled by the plan. */
function planRow(id: string, sessionId: string, createdAt: string, userText: string): TreeRow {
  return {
    id, session_id: sessionId, parent_run_id: null, resumes_run_id: null, spawned_by: 'plan', label: null, model: null, status: 'queued', live: false,
    created_at: createdAt, finished_at: null, workspace_id: null, user_text: userText, user_text_head: headOf(userText), work_order: null,
    receipt: null, error: null, usage: {}, depth: 0, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null,
    plan_node_id: null, participant_id: null, participant_alias: null, participant_index: null, participant_name: null, depends_on: [], scheduled_by: null, kind: 'run',
  }
}

/** How the plan's rows name a group's participants: `names` (the participant name each row carries) and `candidate` (a
 *  participant the person's decision may keep). The app's: participantNames and the participant's own id, as it has
 *  always shown them; a share passes its own (share/team.ts: no harness id). */
export interface PlanRowNaming {
  names: (participants: { id: string; label: string }[]) => Map<string, string>
  candidate: (participantId: string, names: Map<string, string>) => string
}
export const APP_PLAN_NAMING: PlanRowNaming = { names: participantNames, candidate: (id) => id }

/** The tree's rows: the runs as given, decorated where a plan node has them, and the plan's own rows after them. */
export function planRows(runs: TreeRow[], relays: Relay[], interactions: InteractionRows[], naming: PlanRowNaming = APP_PLAN_NAMING): TreeRow[] {
  const byId = new Map(runs.map((r) => [r.id as string, r]))
  const out = [...runs]
  const decorate = (runId: string, fields: TreeRow): boolean => {
    const row = byId.get(runId)
    if (!row) return false
    Object.assign(row, fields)
    return true
  }

  for (const relay of relays) {
    const alias = (i: number): string => relay.participants[i]?.id || String.fromCharCode(65 + i)
    const names = naming.names(relay.participants.map((p, i) => ({ id: alias(i), label: p.label })))
    let previous: string | null = null
    for (const step of relay.steps) {
      const nodeId = `${relay.id}:${step.seq}`
      const id = alias(step.participant)
      // the row's name is the person's request, never the harness's handover message the turn's run opened with
      const fields: TreeRow = { plan_node_id: nodeId, participant_id: `${relay.id}:${id}`, participant_alias: id, participant_index: step.participant,
                                participant_name: names.get(id) ?? null, depends_on: previous ? [previous] : [], kind: 'run', user_text_head: headOf(relay.user_text) }
      const runIds = [...new Set([...step.run_ids, ...(step.run_id ? [step.run_id] : [])])]
      const found = runIds.filter((id) => decorate(id, fields))
      if (found.length) {
        previous = step.run_id && found.includes(step.run_id) ? step.run_id : found[found.length - 1]!
        continue
      }
      const ended = relay.status === 'done' || relay.status === 'cancelled' || relay.status === 'error'
      const status = step.status === 'cancelled' || ended ? 'cancelled' : 'queued'
      out.push({ ...planRow(nodeId, relay.session_id, relay.created_at, relay.user_text), model: relay.participants[step.participant]?.model ?? null, status, relay_id: relay.id, relay_step: step.seq, ...fields })
      previous = nodeId
    }
  }

  for (const { interaction: ix, nodes, director_model, adopted } of interactions) {
    const planId = ix.controller === 'director' ? ix.id : null
    if (planId) {
      const status = ix.status === 'planning' || ix.status === 'deciding' ? 'running'
        : ix.status === 'done' ? 'done' : ix.status === 'cancelled' ? 'cancelled' : ix.status === 'error' ? 'error' : 'waiting'
      out.push({ ...planRow(planId, ix.session_id, ix.created_at, ix.user_text), kind: 'plan', model: director_model, status, finished_at: ix.finished_at,
                 label: `Plan · ${nodes.length} step${nodes.length === 1 ? '' : 's'}`, interaction_id: ix.id })
    }
    const ended = ix.status === 'done' || ix.status === 'cancelled' || ix.status === 'error'
    const names = naming.names(ix.participants)
    const ref = (nodeId: string): string => nodes.find((n) => n.id === nodeId)?.run_id ?? `${ix.id}:${nodeId}`
    for (const node of nodes) {
      const nodeId = `${ix.id}:${node.id}`
      // the row's name is the step's instruction, else the person's request — never the harness's message the run opened with
      const index = ix.participants.findIndex((p) => p.id === node.participant)
      const fields: TreeRow = { plan_node_id: nodeId, participant_id: `${ix.id}:${node.participant}`, participant_alias: node.participant, participant_index: index < 0 ? null : index,
                                participant_name: names.get(node.participant) ?? null, depends_on: node.depends_on.map(ref), scheduled_by: planId, kind: 'run',
                                user_text_head: headOf(node.instruction ?? ix.user_text) }
      const runIds = [...new Set([...node.run_ids, ...(node.run_id ? [node.run_id] : [])])]
      if (runIds.filter((id) => decorate(id, fields)).length) continue
      const model = ix.participants.find((p) => p.id === node.participant)?.model ?? null
      const status = node.status === 'cancelled' || ended ? 'cancelled' : 'queued'
      out.push({ ...planRow(nodeId, ix.session_id, node.created_at, node.instruction ?? ix.user_text), model, status, label: node.instruction, workspace_id: node.workspace_id,
                 interaction_id: ix.id, interaction_node: node.id, ...fields })
    }
    if (ix.then === 'stop' && nodes.length) {
      const leaves = nodes.filter((n) => !nodes.some((m) => m.depends_on.includes(n.id)))
      const candidates = [...new Set(nodes.filter((n) => n.status === 'done' && n.workspace === 'own').map((n) => n.participant))]
      const label = candidates.length ? `Your choice: ${candidates.map((p) => `keep ${naming.candidate(p, names)}`).join(' · ')} · ask for a synthesis` : 'Your choice: continue, ask for more, or stop'
      const status = ix.status === 'done' ? (adopted ? 'done' : 'waiting') : ix.status === 'waiting' ? 'waiting'
        : ix.status === 'cancelled' ? 'cancelled' : ix.status === 'error' ? 'error' : 'queued'
      out.push({ ...planRow(`${ix.id}:decide`, ix.session_id, ix.created_at, ix.user_text), kind: 'decision', status, label, finished_at: status === 'done' ? ix.finished_at : null,
                 interaction_id: ix.id, depends_on: leaves.map((n) => ref(n.id)), scheduled_by: planId })
    }
  }
  return out
}

/** Each row's depth under who scheduled it (the plan row) or its parent run; a parent not in the list makes a root. */
export function stampDepths(rows: TreeRow[]): void {
  const parents = new Map(rows.map((r) => [r.id as string, ((r.scheduled_by ?? r.parent_run_id) as string | null)]))
  const depth = new Map<string, number>()
  const depthOf = (id: string, seen: Set<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    const parent = parents.get(id) ?? null
    const d = parent && parents.has(parent) && !seen.has(parent) ? depthOf(parent, new Set([...seen, id])) + 1 : 0
    depth.set(id, d)
    return d
  }
  for (const row of rows) row.depth = depthOf(row.id as string, new Set())
}
