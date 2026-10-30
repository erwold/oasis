/** What every tool sees: the run, its session and workspace, the services (git host, process manager, gate, store)
 *  and the emit function. Tools never reach the database or the disk another way. */

import type { ToolSnapshot } from '../db/collab_repo.ts'
import type { LockSpec, Project, Session, Workspace } from '@oasis-code/contract'
import type { HarnessConfig, ModelConfig } from '../config.ts'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import type { ProcessManager } from '../execution/processes.ts'
import type { ModelMessage } from '../llm/messages.ts'
import type { ContextKeeper } from './history.ts'
import type { ActionGate } from '../policy/permissions.ts'
import type { AssetStore } from '../store.ts'
import type { PathPolicy } from '../workspace/paths.ts'
import type { WorkspaceService } from '../workspace/service.ts'
import type { WorkOrder } from './work_orders.ts'
import type { ComputerClient } from '../computer/desktop.ts'

export type Emit = (event: string, data: Record<string, unknown>) => void

/** What a run's tools reach of the watch service (the service itself imports the runner). */
export interface WatchRegistrar {
  register(o: { session_id: string; run_id: string; note: string; input: import('./watches/conditions.ts').WatchInput }): import('@oasis-code/contract').Watch | { error: string }
  cancel(watchId: string, by: 'agent' | 'person'): boolean
  /** which conversation each run of the session holds (a key per conversation) */
  conversationsOf(sessionId: string): (runId: string) => string
}

/** What a run's SSH tools reach: the hosts service (a question, then the person's yes), the connections, and the
 *  app's own API in process (a session opened on a host is made as the person's Start makes it). */
export interface SshPort {
  hosts: import('../workspace/ssh_hosts.ts').SshHostsService
  remote: import('../workspace/remote.ts').RemoteWorkspaceService
  api: () => import('../director/harness.ts').Harness | null
}

export interface AgentDeps {
  conn: Conn
  store: AssetStore
  config: HarnessConfig
  project: Project
  session: Session
  workspace: Workspace
  run_id: string
  model_cfg: ModelConfig
  workspaces: WorkspaceService
  processes: ProcessManager
  gate: ActionGate
  policy: PathPolicy
  emit: Emit
  cancelled: () => boolean
  // the run's Stop as a signal: a tool that waits on something outside (a download) ends it with the run
  cancel_signal: AbortSignal
  on_history: (messages: ModelMessage[]) => void
  // the working context's keeper: predicts the next request's size and compacts the record near the window (null: never)
  context: ContextKeeper | null
  pending_notes: string[]
  // the runner's closing signal: a reason once a hard budget line is crossed (the closing turn keeps its tool
  // descriptions, for the prompt cache, but no tool runs in it)
  closing: () => string | null
  closing_requests: number
  tool_calls: number
  // what the run produced, filled by the tools: checkpoints, executions, checks
  produced: { checkpoints: string[]; executions: string[]; checks: string[] }
  // the version (sha256) of each file this run read or wrote, by workspace-relative path: a write over an existing
  // file must match it (the file was read, and has not changed since)
  seen: Map<string, string>
  // the work order this run works under (null for a thread's own runs): the tools it sees, read-only, its scope,
  // its execution policy. blocked_calls: calls the order or Plan mode refused
  work_order: WorkOrder | null
  blocked_calls: number
  // a run whose conversation a watch's report can continue (every one but a UI task's): the watches are its tools;
  // and the service that keeps them (null where there is none)
  watchable: boolean
  // schema v25: the tool list the run's conversation holds (every request carries exactly it), and what this run may
  // call of it now — a call of a listed tool the run's order or role no longer allows is refused at the call
  tool_snapshot: ToolSnapshot | null
  tool_allowed: Set<string> | null
  watches: WatchRegistrar | null
  // the desktop app's computer: the pages computer use looks at and acts on (null where there is none); whether this
  // run asked it anything (what it holds is let go when it ends)
  computer: ComputerClient | null
  computer_used: boolean
  // the hard locks every write is checked against (session + project + order), read fresh at each call; the calls
  // a lock refused and the violations a command left behind (counted into the receipt)
  locks: () => LockSpec[]
  lock_refusals: number
  lock_violations: number
  // the instruction sources the run has been shown (the first message's, and a folder's when the run entered it)
  instruction_scopes: Set<string>
  // the version (sha256) each shown instruction file had when it was shown: a file rewritten meanwhile is shown again
  instruction_versions: Map<string, string>
  // the instruction sources noted for the next request and not yet in front of the model: a change in their folder
  // waits until they are
  instructions_pending: Set<string>
  // folders with instruction files the first message only named (over the discovery limit): a command, which can
  // reach any folder, waits until they are shown
  instructions_undelivered: string[]
  // the UI task this run does (contract/src/ui_interaction.ts): return_ui_result sends its data; null for any other run
  ui_task: string | null
  // who stopped the run, as a wait it ended says it: the person (cancelled), its hard limit (budget), the app shutting
  // down (interrupted)
  stop_reason: () => 'cancelled' | 'budget' | 'interrupted'
  // the person's words sent while the run works (agent/steering.ts): null where the run takes none
  steering: import('./steering.ts').SteeringPort | null
  // the SSH hosts and their connections (null where there are none: a test's deps)
  ssh: SshPort | null
}

export function rootOf(deps: AgentDeps): string {
  return deps.workspace.path
}

export function refreshSession(deps: AgentDeps): Session {
  const session = repo.getSession(deps.conn, deps.session.id)
  if (session !== null) deps.session = session
  return deps.session
}

/** The deps with every optional seam at its default (what a test or a one-off caller fills in). */
export function makeDeps(base: Pick<AgentDeps, 'conn' | 'store' | 'config' | 'project' | 'session' | 'workspace' | 'run_id' | 'model_cfg' | 'workspaces' | 'processes' | 'gate' | 'policy' | 'emit'>
  & Partial<AgentDeps>): AgentDeps {
  return {
    cancelled: () => false, cancel_signal: new AbortController().signal, on_history: () => {}, context: null, pending_notes: [], closing: () => null, closing_requests: 0,
    tool_calls: 0, produced: { checkpoints: [], executions: [], checks: [] }, seen: new Map(),
    work_order: null, blocked_calls: 0, watchable: false, tool_snapshot: null, tool_allowed: null, watches: null, computer: null, computer_used: false, locks: () => [], lock_refusals: 0, lock_violations: 0, instruction_scopes: new Set(), instruction_versions: new Map(), instructions_pending: new Set(), instructions_undelivered: [], ui_task: null, stop_reason: () => 'cancelled', steering: null, ssh: null,
    ...base,
  }
}
