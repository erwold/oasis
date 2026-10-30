/** Work an agent starts elsewhere is never wider than the run that starts it. A run's tool that opens a session on an
 *  SSH host and sends it a message (agent/tools/ssh.ts open_ssh_session) goes through the app's own API in process;
 *  its requests carry the run's id (AGENT_RUN_HEADER), checked here against the live runs, so the API knows them for
 *  the agent's — never the person's — and holds what they start to the calling run's bounds:
 *
 *  - access: the calling run's effective access (its session's, narrowed by the run's cap). A session on an SSH host
 *    runs its commands with Full access on that host (no sandbox there), so a sandboxed caller is refused;
 *  - the mode: the caller's run control as the run sees it (session-wide, or one scoped to the run or its parent). A
 *    caller that pauses any gateable action (write_file, edit_file, bash, computer_act) makes the new session
 *    "Ask before changes", whose gate pauses every one of them; a caller in Plan is refused;
 *  - the grants: the new session's are the caller's at most (writes, commands, the attached folder, the network and
 *    its expiry);
 *  - a work order: a run under one is held to it (its tools, read-only, scopes, locks, commands, network, budget); a
 *    session opened elsewhere is held to none of that, so the call is refused rather than dropping the order;
 *  - a hard budget: a run without an order may hold one too (requests, total tokens, wall-clock seconds, tool calls:
 *    the lines set on its row); the run a session elsewhere starts would hold none, so the call is refused. Both are
 *    read from the calling run's row — what the server stored — never from what a model or a tool passes.
 *
 *  Each answer here only narrows or refuses: a request without the header is read as before (the person, a director,
 *  a connector), and a header that does not check out is refused, never read as the person's. */

import type { Grants, Session } from '@oasis-code/contract'
import type { HarnessMode } from '@oasis-code/contract/modes'
import { inferMode } from '@oasis-code/contract/modes'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { budgetLines } from '../models.ts'
import { effectiveAccess, type RequestAgent } from './access.ts'
import { effectiveControl, effectsFor, GATEABLE_TOOLS, shouldGate, type RunControl } from './gate.ts'
import { networkGranted } from './permissions.ts'

export type DelegationRefusalCode = 'sandbox_unavailable' | 'work_order_bounds' | 'run_budget' | 'plan_mode' | 'invalid_agent_context' | 'wider_than_caller'

export class DelegationRefused extends Error {
  constructor(readonly code: DelegationRefusalCode, message: string) { super(message); this.name = 'DelegationRefused' }
}

/** What work the calling run starts elsewhere is held to. */
export interface DelegationBound {
  run_id: string
  session_id: string
  /** the caller's run control as its run sees it */
  control: RunControl
  /** the mode a session it opens gets at least */
  mode: Extract<HarnessMode, 'auto' | 'approve'>
  /** the grants a session it opens gets at most */
  grants: Grants
}

/** The calling run as a tool knows it (its deps) or the API reads it (its row). */
export interface DelegationCaller {
  run_id: string
  session_id: string
  parent_run_id?: string | null
  /** the order the caller says it runs under (a tool's deps); the run's row is read besides it, and either refuses */
  work_order?: unknown
}

/** The bounds of work `caller` starts elsewhere, or DelegationRefused when they cannot be carried there. */
export function delegationBound(conn: Conn, caller: DelegationCaller): DelegationBound {
  const session = repo.getSession(conn, caller.session_id)
  if (session === null) throw new DelegationRefused('invalid_agent_context', `the calling session ${caller.session_id} is gone; nothing was started`)
  // the run as the server recorded it: its order and its budget are read here, not taken from the caller
  const run = repo.getRun(conn, caller.run_id)
  if (run === null || run.session_id !== session.id) throw new DelegationRefused('invalid_agent_context', `the calling run ${caller.run_id} is not on record in session ${session.id}; nothing was started`)
  if ((caller.work_order !== null && caller.work_order !== undefined) || run.work_order !== null) {
    throw new DelegationRefused('work_order_bounds', 'This run works under a work order (its tools, read-only, scopes, locks, commands, network and budget); a session opened on an SSH host would be held to none of it. Nothing was started: do the work within the order, or ask the dispatcher to do it from a session without one.')
  }
  // only the lines set count (budgetLines: a number on the line; absent, undefined and null are no limit)
  const limits = budgetLines(run.budget)
  if (Object.keys(limits).length) {
    const said = Object.entries(limits).map(([k, v]) => `${k} ${v}`).join(', ')
    throw new DelegationRefused('run_budget', `This run has a hard budget (${said}); a session opened on an SSH host would start a run held to none of it. Nothing was started on the host: do the work within this run, or ask the person to open the session there.`)
  }
  const access = effectiveAccess({ session, run_cap: repo.runAccessCap(conn, caller.run_id) })
  if (access !== 'full') {
    throw new DelegationRefused('sandbox_unavailable', 'This run\'s commands are held in the sandbox; a session on an SSH host runs its commands with Full access on that host (no sandbox is available there), which would be wider than this run. Nothing was started: only the person can open it, from oasis-code.')
  }
  const control = effectiveControl(conn, session.id, caller.run_id, caller.parent_run_id ?? null)
  if (inferMode(session.grants, control) === 'plan') {
    throw new DelegationRefused('plan_mode', 'The session is in Plan mode: an agent opens no session and starts no work elsewhere. Nothing was started.')
  }
  const pauses = [...GATEABLE_TOOLS].some((tool) => shouldGate(effectsFor(tool), control))
  return { run_id: caller.run_id, session_id: session.id, control, mode: pauses ? 'approve' : 'auto', grants: { ...session.grants } }
}

const MODE_RANK: Record<HarnessMode, number> = { auto: 0, approve: 1, plan: 2 }

/** The stricter of two modes (a mode asked for, the bound's). */
export function stricterMode(asked: HarnessMode | null | undefined, bound: HarnessMode): HarnessMode {
  return asked && MODE_RANK[asked] > MODE_RANK[bound] ? asked : bound
}

function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return Date.parse(a) <= Date.parse(b) ? a : b
}

/** `grants` held to the bound's: each one only where the caller holds it too; the network until the earlier expiry. */
export function narrowGrants(grants: Grants, bound: Grants): Grants {
  const network = grants.network && networkGranted(bound)
  return {
    ...grants,
    workspace_write: grants.workspace_write && bound.workspace_write,
    run_commands: grants.run_commands && bound.run_commands,
    attached_write: grants.attached_write && bound.attached_write,
    network,
    network_until: network ? earlier(grants.network_until, bound.network_until) : grants.network_until,
    network_reason: network ? grants.network_reason : (bound.network_reason ?? grants.network_reason),
  }
}

/** Why `target` is wider than the bound (a reason to refuse a message to it), or null when it is within it. */
export function widerThanBound(conn: Conn, target: Session, bound: DelegationBound): string | null {
  const g = target.grants
  const b = bound.grants
  if (g.workspace_write && !b.workspace_write) return 'it may write its folder, the calling session may not'
  if (g.run_commands && !b.run_commands) return 'it may run commands, the calling session may not'
  if (g.attached_write && !b.attached_write) return 'it may write an attached folder, the calling session may not'
  if (networkGranted(g) && !networkGranted(b)) return 'it has the network, the calling session does not'
  if (networkGranted(g) && b.network_until !== null && (g.network_until === null || Date.parse(g.network_until) > Date.parse(b.network_until))) return 'its network grant outlasts the calling session\'s'
  const control = effectiveControl(conn, target.id)
  for (const tool of GATEABLE_TOOLS) {
    if (shouldGate(effectsFor(tool), bound.control) && !shouldGate(effectsFor(tool), control)) return `it runs ${tool} without asking, the calling session asks first`
  }
  return null
}

/** The agent run a request's header names, checked: a live run of a session that exists. Null when it does not
 *  check out (the request is refused, never read as another caller's). */
export function agentCaller(conn: Conn, isLive: (runId: string) => boolean, runId: string): RequestAgent | null {
  const run = repo.getRun(conn, runId)
  if (run === null || !isLive(run.id)) return null
  if (repo.getSession(conn, run.session_id) === null) return null
  return { run_id: run.id, session_id: run.session_id }
}

/** The bounds of the request's agent run, read from its row. */
export function boundOfAgent(conn: Conn, agent: RequestAgent): DelegationBound {
  const run = repo.getRun(conn, agent.run_id)
  if (run === null) throw new DelegationRefused('invalid_agent_context', `the calling run ${agent.run_id} is gone; nothing was started`)
  return delegationBound(conn, { run_id: run.id, session_id: run.session_id, parent_run_id: run.parent_run_id })
}

/** What an agent's request may reach of the API: reading, and the three steps of opening a session on an SSH host
 *  (its project, its session, the message that starts its run). Anything else — a grant, a mode, an access, a
 *  decision on a proposal — is the person's. */
export function agentRouteAllowed(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return true
  if (method !== 'POST') return false
  return path === '/api/projects' || /^\/api\/projects\/[^/]+\/sessions$/.test(path) || /^\/api\/sessions\/[^/]+\/chat$/.test(path)
}
