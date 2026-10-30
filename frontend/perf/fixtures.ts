/** The bench's session: one thread run and `n` agents it dispatched — `live` of them still running, every tenth one
 *  waiting on the one before it (a dependency line in the outline), each finished one with a stored conversation of
 *  `entries` rows. Plain data, the shapes the backend answers with (contract/src/api.ts). */

export interface BenchData {
  session: Record<string, unknown>
  tree: Record<string, unknown>[]
  threadRun: Record<string, unknown>
  transcripts: Record<string, { run_id: string; status: string; model: string; entries: Record<string, unknown>[]; steers: [] }>
  liveIds: string[]
  finishedIds: string[]
}

const T0 = Date.parse('2026-10-01T00:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

function row(id: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id, session_id: 'ses_bench', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null,
    model: 'anthropic:claude-bench', status: 'done', live: false, created_at: iso(T0), finished_at: iso(T0 + 60_000),
    workspace_id: null, user_text: 'do the thing', user_text_head: 'do the thing', work_order: null, receipt: null, error: null,
    usage: {}, depth: 0, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, plan_node_id: null,
    participant_id: null, participant_alias: null, participant_index: null, participant_name: null, depends_on: [],
    scheduled_by: null, kind: 'run', collab: null, ...over,
  }
}

export function benchData(n: number, live: number, entries: number): BenchData {
  const threadRun = row('run_main', { created_at: iso(T0), finished_at: iso(T0 + 3_600_000) })
  const tree: Record<string, unknown>[] = [threadRun]
  const transcripts: BenchData['transcripts'] = {}
  const liveIds: string[] = [], finishedIds: string[] = []
  for (let i = 0; i < n; i += 1) {
    const id = `run_agent_${String(i).padStart(4, '0')}`
    const running = i >= n - live
    const created = T0 + 1000 * (i + 1)
    tree.push(row(id, {
      parent_run_id: 'run_main', spawned_by: 'run:run_main', label: `agent ${i}`, depth: 1,
      work_order: { version: 1, label: `agent ${i}`, prompt: `task ${i}`, model: null, tools: null, read_only: false, goal: null },
      status: running ? 'running' : 'done', live: running, created_at: iso(created), finished_at: running ? null : iso(created + 120_000),
      depends_on: i > 0 && i % 10 === 0 ? [`run_agent_${String(i - 1).padStart(4, '0')}`] : [],
    }))
    ;(running ? liveIds : finishedIds).push(id)
    const rows: Record<string, unknown>[] = []
    for (let k = 0; k < entries; k += 1) {
      rows.push(k % 3 === 2
        ? { kind: 'agent', text: `Step ${k} of ${id}: what it found, in a paragraph of **prose** that the card renders as markdown.` }
        : { kind: 'activity', tool: 'read_file', toolCallId: `${id}-call-${k}`, summary: `read src/file_${k}.ts`, args: { path: `src/file_${k}.ts` }, result: { status: 'ok' }, running: false })
    }
    transcripts[id] = { run_id: id, status: running ? 'running' : 'done', model: 'anthropic:claude-bench', entries: rows, steers: [] }
  }
  const session = {
    id: 'ses_bench', title: 'bench session', created_at: iso(T0), updated_at: iso(T0), model: 'anthropic:claude-bench',
    workspace: null, director: null, runs: [], notes: [],
  }
  return { session, tree, threadRun, transcripts, liveIds, finishedIds }
}
