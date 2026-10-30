/** A session's agents board as large as asked: `lanes` agents, each with two runs ended long ago, but for four that
 *  must keep their lanes — one running, one with a step still to come, one whose watch still waits, one that ended a
 *  moment ago — and a handover between every agent and the next. */

import type { CollaborationGraph } from '@oasis-code/contract'

export const T0 = Date.parse('2026-10-14T04:00:00Z')
export const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const origin = (actor: string) => ({ actor, request: 'message', client: null, director_session_id: null, director_turn_id: null, tool_call_id: null, interaction_id: null, relay_id: null, watch_id: null, ui_task_id: null, parent_run_id: null, basis: 'recorded' })

export const BIG_NOW = T0 + 10_000 * 60_000

export function bigBoard(lanes: number): { graph: CollaborationGraph; watched: string } {
  const participants = []
  const runs = []
  const edges = []
  for (let i = 0; i < lanes; i++) {
    const pid = `p${i}`
    participants.push({ id: pid, session_id: 's', role: 'member', alias: `a${i}`, label: `Agent ${i}`, model: 'm', group: { kind: 'interaction', id: 'ix' }, introduced_by: origin('director'), current_conversation_id: null, latest_run_id: `r${i}b`, state: 'idle', run_count: 2, basis: 'recorded' })
    // two runs each, all over within the first few hours (the ones of the agents 0 and 3 later)
    const start = i * 3
    const ends = [start + 1, start + 2]
    if (i === 3) ends[1] = (BIG_NOW - T0) / 60_000 - 5                                                   // ended five minutes ago
    for (const [k, suffix] of (['a', 'b'] as const).entries()) {
      const live = i === 0 && suffix === 'b'
      runs.push({
        id: `r${i}${suffix}`, status: live ? 'running' : 'done', live, model: 'm', label: null, created_at: at(start + k), finished_at: live ? null : at(ends[k]!),
        workspace_id: null, resumes_run_id: null, interaction_id: 'ix', interaction_node: `n${i}`, relay_id: null, relay_step: null, user_text_head: `asked ${i}`,
        final_text_chars: live ? null : 10, error: null,
        collab: { participant_id: pid, participant_role: 'member', conversation_id: null, conversation_seq: null, origin: origin('director'), placement: { surface: 'thread', group: null, anchor: null } },
      })
    }
    if (i > 0) edges.push({ id: `e${i}`, kind: 'received', from: { kind: 'run', id: `r${i - 1}b` }, to: { kind: 'run', id: `r${i}a` }, basis: 'recorded', created_at: at(start), meta: { handed_chars: 100 } })
  }
  const nodes = [{ id: 'ix/later', interaction_id: 'ix', node_id: 'later', kind: 'plan', participant_id: 'p1', alias: 'a1', status: 'queued', run_ids: [], current_run_id: null, depends_on: [], receives: [], receive_runs: [], cites: [], workspace: 'own', wave: 9 }]
  const graph = {
    actors: [{ kind: 'person' }, { kind: 'director', id: 'd', transport: 'native', label: 'Opus', model: 'opus', state: 'idle', tool_surface: 'director.v2', open: true }],
    participants, runs, edges, nodes,
    groups: [{ kind: 'interaction', id: 'ix', status: 'running', controller: 'director', template: 'discussion', then: null, workspace_policy: null, rounds: null, participant_ids: participants.map((p) => p.id), runs_started: runs.length, max_runs: null, concurrency: null, origin: null, anchor: null, reason: null, created_at: at(0), finished_at: null }],
  } as unknown as CollaborationGraph
  return { graph, watched: 'r2b' }
}
