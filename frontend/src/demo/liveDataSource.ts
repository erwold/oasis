/** What an agent's card reads beside the stores (its records, a command's output, a worktree's changes and checks),
 *  answered in memory from the simulator for the live UI demo — handed to the desk's cards as their data source, so
 *  every tab of a card opens without a request to the harness. SIMULATED. One object per demo, its answers read the
 *  simulator's state at the moment they are asked. */

import type { DiffResponse, OutputWindow, RunDetailResponse, WorkspaceDetail } from '../api/types'
import { demoRuns, runRecord, type DemoRun } from './liveFixtures.ts'
import { stepMetrics, type SimState } from './liveSim.ts'

/** the desk's card data source (Desk.tsx CardDataSource): Pick<typeof api, 'run' | 'output' | 'diff' | 'workspace'> */
export type LiveDataSource = Pick<typeof import('../api/client').api, 'run' | 'output' | 'diff' | 'workspace'>

const iso = (ms: number) => new Date(Math.round(ms)).toISOString()
const thousands = (n: number) => n.toLocaleString('en-US')

/** the command a run has at work, else its last (its last bash call), as the run's one execution */
function commandOf(run: DemoRun): { toolCallId: string; command: string } | null {
  const call = run.events.findLast((e) => e.event === 'tool_call' && e.data.tool === 'bash')
  return call ? { toolCallId: String(call.data.tool_call_id), command: String(call.data.command) } : null
}

const executionId = (runId: string) => `ex_${runId.slice(4)}`

function executionOf(run: DemoRun) {
  const cmd = commandOf(run)
  if (!cmd) return null
  const result = run.events.find((e) => e.event === 'tool_result' && e.data.tool_call_id === cmd.toolCallId)
  const running = run.status === 'running' && !result
  const exit = result ? Number(result.data.exit_code ?? 0) : null
  return {
    id: executionId(run.id), run_id: run.id, workspace_id: null, tool_call_id: cmd.toolCallId, kind: 'bash', command: cmd.command, cwd: '/srv/runs/r14',
    status: running ? 'running' as const : exit === 0 ? 'succeeded' as const : 'failed' as const, effect_state: running ? 'not_started' as const : 'applied' as const,
    exit_code: running ? null : exit, timed_out: false, cancelled: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null,
    stdout_bytes: 0, stderr_bytes: 0, started_at: iso(run.createdAt), finished_at: run.finishedAt === null ? null : iso(run.finishedAt),
    duration_ms: run.finishedAt === null ? null : Math.round(run.finishedAt - run.createdAt), isolation: {}, network: false, created_at: iso(run.createdAt),
  }
}

/** a command's log as it stands: the trainer's step lines, an eval's batches, a sweep's proxy run */
function logOf(run: DemoRun, sim: SimState): string {
  if (run.agent.key === 'trainer') {
    const lines: string[] = []
    const last = Math.floor(sim.step / 10) * 10
    for (let s = Math.max(10, last - 390); s <= last; s += 10) {
      const m = stepMetrics(sim.seed, s)
      lines.push(`step ${String(s).padStart(5)} | loss ${m.trainLoss.toFixed(4)} | grad ${m.gradNorm.toFixed(2)}${m.clipped ? '*' : ' '} | ${m.tokPerSec === null ? 'saving ckpt   ' : `${m.tokPerSec.toFixed(1)}k tok/s`} | lr 3.00e-04`)
    }
    return `${lines.join('\n')}\n`
  }
  if (run.agent.key === 'evaluator') {
    const text = run.events.find((e) => e.event === 'text_delta' || e.event === 'text_block')?.data.text
    const batches = run.status === 'running' ? Number(/batch (\d+)/.exec(String(text))?.[1] ?? 1) : 64
    return `${Array.from({ length: batches }, (_, i) => `eval batch ${String(i + 1).padStart(2)}/64`).join('\n')}\n${run.status === 'done' ? `${String(text)}\n` : ''}`
  }
  const text = run.events.find((e) => e.event === 'text_block')?.data.text
  return `proxy-600 · ${thousands(600)} steps\n${String(text ?? '')}\n`
}

export function createLiveDataSource(current: () => SimState): LiveDataSource {
  const find = (id: string) => demoRuns(current()).find((r) => r.id === id) ?? null
  const byExecution = (id: string) => demoRuns(current()).find((r) => executionId(r.id) === id) ?? null
  const source: LiveDataSource = {
    run: async (id: string) => {
      const run = find(id)
      if (!run) throw new Error(`no run ${id} in the demo`)
      const execution = executionOf(run)
      return { ...runRecord(run), manifest: {}, live: run.status === 'running', depth: 0, requests: [], executions: execution ? [execution] : [], children: [] } as RunDetailResponse
    },
    output: async (id: string, stream: string, offset = 0, limit = 65536) => {
      const run = byExecution(id)
      const full = run && stream === 'stdout' ? logOf(run, current()) : ''
      const text = full.slice(offset, offset + limit)
      const running = run ? executionOf(run)?.status === 'running' : false
      return {
        execution_id: id, stream, offset, returned_bytes: text.length, total_bytes: full.length, next_offset: offset + text.length,
        eof: !running && offset + text.length >= full.length, running, status: running ? 'running' : 'succeeded', exit_code: running ? null : 0, truncated_at_cap: false, text,
      } satisfies OutputWindow
    },
    diff: async () => ({ base_commit: '0000000', tree_sha: '0000000', snapshot_id: null, patch: '', files: [], external_changes: [], review_flags: [], patch_cut: null }) satisfies DiffResponse,
    // the demo's runs have no worktree: a card says so and never asks; asked anyway, an empty one
    workspace: async (id: string) => ({ id, status: 'ready', lock_owner: null, latest_snapshot: null, checkpoints: [], executions: [], checks: [] }) as unknown as WorkspaceDetail,
  }
  return source
}
