/** Command tools. bash runs a shell command where the session's access puts it (contract/modes.ts):
 *  - Sandbox: inside the OS isolation runtime — treated as possibly-writing isolated execution whatever the command is
 *    called; a work order's boundaries (read-only, its read and write scope, the protected paths), a hard lock of a
 *    folder edited in place and the network policy go into the sandbox with the command, so the kernel holds them for
 *    what the command runs as the file tools hold them.
 *  - Full access: on the host, as the user, with what the user's login and interactive shell sets up (a snapshot of
 *    it, execution/host_env.ts) — no kernel rule of the harness's holds for it: the protected paths, the working-folder
 *    bounds and the checkpoints are the file tools' (they still hold for write_file / edit_file) and a Full access
 *    command may change anything the user can. A restriction chosen for the command — the network off, a work order's
 *    read-only / scope bounds, a hard
 *    lock of a folder edited in place, a read-only command, a folder the session holds read-only — is held by the OS
 *    on the host around that same shell, and nothing else of the sandbox's (no private HOME, no credential deny, no
 *    resource limit): execution/isolation.ts hostProfile. One the OS of this host cannot be shown to hold refuses the
 *    command. A cap of a director surface v1–v5, a request's cap or an older proposal's pin keeps the sandbox
 *    (policy/access.ts).
 *  Every result says what was asked, where it ran and why (requested_access, effective_access, access_reasons) and
 *  what held it (restrictions). Either way its output streams to log files on disk — kept whole with Full access
 *  unless a retention cap is configured, under the sandbox's cap in it; what was not kept is said — read back in
 *  bounded pages; it has its own process group and the stray sweep; a deadline only when given (or configured, or the
 *  sandbox's). Long commands return an execution id and go on; bash_output reads the logs while they run;
 *  stop_command kills the group. */

import { statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as repo from '../../db/repo.ts'
import { answerOtherFullAccessAsks, awaitAnswer, fullAccessConfirmed, fullAccessRequest } from '../ui_inputs.ts'
import { z, type Execution, type LockSpec, type Project, type WorkOrder, type Workspace } from '@oasis-code/contract'
import type { HarnessConfig } from '../../config.ts'
import { HostRestrictionUnavailable, IsolationUnavailable, type HostRestrictions, type Sandbox } from '../../execution/isolation.ts'
import type { CommandLauncher, ProcessManager } from '../../execution/processes.ts'
import { checkActionGate, effectiveControl, setGateHooks, shouldGate, type PinnedPermissions } from '../../policy/gate.ts'
import { allowsAgentEffect, inferMode } from '@oasis-code/contract/modes'
import { networkGranted } from '../../policy/permissions.ts'
import { checkTree } from '../../policy/locks.ts'
import { PathPolicy, resolveReal } from '../../workspace/paths.ts'
import { RemotePathPolicy } from '../../workspace/remote_policy.ts'
import { RemoteOutcomeUnresolved } from '../../workspace/remote.ts'
import { haltOnUnresolved } from './files.ts'
import { noteRemoteInstructions } from '../remote_instructions.ts'
import { sandboxForWorkspace, type OrderInput } from '../../workspace/sandbox.ts'
import { rootPolicyOptions } from '../../workspace/roots.ts'
import { type WorkspaceService, workspaceAttached, isDirect } from '../../workspace/service.ts'
import { refreshSession, type AgentDeps } from '../deps.ts'
import { finish, heldForInstructions, noteFolderInstructions, noteUndeliveredInstructions, orderRefused, pendingScopes, refused, type Ctx, type Payload } from './common.ts'
import { MAX_DISCOVERED_FILES } from '../project_instructions.ts'
import { PROMPT_TEXT, text } from '../../prompt_texts.ts'
import { register } from './registry.ts'
import type { AccessMode } from '@oasis-code/contract/modes'
import { accessDecision, currentRequestCap, orderFilesystemBounds, reason, type AccessDecision, type AccessReason } from '../../policy/access.ts'
import { HostShellRefused } from '../../execution/host_env.ts'
import { sessionInputFiles } from '../attachment_grants.ts'
import { authorizedPaths, type AuthorizedInputFiles } from '../../workspace/attachment_access.ts'

export const MAX_WAIT_S = 600

/** What the sandbox holds a command to under a work order, with the protected paths in force (the policy's: the
 *  harness's, the project's, the order's, and the Git metadata): what the file tools refuse, the kernel refuses. */
export function orderBounds(order: WorkOrder | null, policy: PathPolicy): OrderInput {
  return { read_only: order?.read_only ?? false, read: order?.scope.read ?? null, write: order?.scope.write ?? null, protected: [...policy.protected] }
}

/** The network a command gets: the session's grant, the order's policy, and — for an approved proposal — no more
 *  than the call would have had when it was proposed. */
export function commandNetwork(grants: Parameters<typeof networkGranted>[0], order: WorkOrder | null, pinned: PinnedPermissions | null = null): boolean {
  return networkGranted(grants) && (order === null || order.execution.network) && (pinned === null || pinned.network)
}

export function sandboxFor(deps: AgentDeps, opts: { network: boolean }): Sandbox {
  // the folder-write grant as the run's policy read it at its start (the next run reads a changed grant)
  return sandboxForWorkspace(deps.workspaces.settings.data_dir, deps.project, deps.workspace, {
    ...opts, attached_write: deps.policy.attached?.writable === true, order: orderBounds(deps.work_order, deps.policy), attached: deps.policy.attached,
    roots: deps.policy.roots,
  })
}

export { sandboxForWorkspace, worktreeGitDir } from '../../workspace/sandbox.ts'

export interface ExecuteOptions {
  processes: ProcessManager; workspaces: WorkspaceService; config: HarnessConfig; project: Project; workspace: Workspace; policy: PathPolicy;
  locks: LockSpec[]; run_id: string | null; tool_call_id: string | null; command: string; timeout_s?: number | null; wait_s?: number;
  network?: boolean; cwd?: string | null; on_started?: ((execution: Execution, workdir: string, timeout: number | null) => void) | null
  /** the command writes nothing of the session's folders: the OS refuses its writes to the working folder, its Git
   *  metadata (its own, an outside metadata folder, the base repository), an attached folder and every one of `roots`
   *  — on the host with Full access (the user's environment kept), in the sandbox otherwise. Never guessed from the
   *  command; refused (`restriction_unavailable`) when the OS cannot hold it. It changes no tree: no write is noted and
   *  no lock is compared after it */
  read_only?: boolean
  /** the session's other folders (absolute real paths) and their access: a 'read' one is denied the command's writes
   *  by the OS (with Full access too); a 'write' one is writable in the sandbox as the working folder is */
  roots?: readonly CommandRoot[] | null
  /** the work order the command runs under: its boundaries go into the sandbox */
  order?: WorkOrder | null
  /** the session's sent upload references as authorizeInputFiles granted them (agent/attachment_grants.ts
   *  sessionInputFiles): the exact files the command reads, one literal read-only rule each. What it refused stays
   *  denied; the result says so (`attachment_access_refused`), and `on_input_refused` hears it */
  input_files?: AuthorizedInputFiles | null
  on_input_refused?: ((refused: readonly { asset_id: string; reason: string }[]) => void) | null
  /** what the command may do, decided again at the last moment before its process is made — after every wait of
   *  this path (the folder's adoption, a lock's tree), with nothing awaited between this reading and the start (which
   *  counts the command as its session's at once, api/gate.ts): whether it may run at all now (the mode, the command
   *  grant, the gate — a change since the first check refuses it: nothing runs), its network and its access. Omitted:
   *  the sandbox with `network`. The network off and a hard lock of a folder edited in place (both only the kernel
   *  holds for a command) narrow the access to the sandbox whatever it says */
  decide?: (() => CommandDecision) | null
  /** the run was stopped: a remote start being settled stops waiting for its receipt */
  cancelled?: (() => boolean) | null
  /** who starts it, kept on its execution record: a run's own tool, an approved proposal, the connector's route */
  launched_by?: CommandLauncher | null
}

/** A command's last-moment decision: refused (nothing runs), or its network and its access — and, when the caller
 *  knows them, what was asked and why the access is what it is (policy/access.ts accessDecision). */
export type CommandDecision = { refused: string } | { network: boolean; access: AccessMode; requested_access?: AccessMode; access_reasons?: AccessReason[] }

/** A folder of the session's beside its working folder, and what its commands may do there. */
export interface CommandRoot { path: string; access: 'read' | 'write' }

/** Whether a command of the session may run now, by the session's mode, its command grant and the gate, as they stand
 *  in the database: the reason it may not, or null. `approved`: an approval the person gave for exactly this call
 *  stands in for the grant and the gate (an approved proposal; a consumed per-call approval). */
export function commandRefusedNow(conn: AgentDeps['conn'], sessionId: string, opts: { run_id?: string | null; parent_run_id?: string | null; approved?: { grant?: boolean; gate?: boolean } } = {}): string | null {
  const session = repo.getSession(conn, sessionId)
  if (session === null) return `session ${sessionId} is gone; nothing ran`
  const control = effectiveControl(conn, session.id, opts.run_id ?? null, opts.parent_run_id ?? null)
  if (!allowsAgentEffect(inferMode(session.grants, control), 'isolated_code_execution')) return PROMPT_TEXT['refusal.plan']
  if (!session.grants.run_commands && opts.approved?.grant !== true) return 'the session no longer grants commands; nothing ran'
  if (shouldGate(new Set(['isolated_code_execution']), control) && opts.approved?.gate !== true) return 'the session now asks before a command runs; nothing ran'
  return null
}

/** Where a run's command may run, and why: the session's access as it stands, narrowed by the run's cap, with its work
 *  order's bounds said (policy/access.ts) — read when called, from the database. */
export function commandAccessDecision(deps: Pick<AgentDeps, 'conn' | 'session' | 'run_id' | 'work_order'>): () => AccessDecision {
  // a run's command: the run's cap carries what its starter could give (never a request's, read from the run's task)
  return () => {
    const session = repo.getSession(deps.conn, deps.session.id) ?? deps.session
    return accessDecision({ session, run_cap: deps.run_id ? repo.runAccessCap(deps.conn, deps.run_id) : null, order: deps.work_order })
  }
}

/** Where a run's command may run (commandAccessDecision's access). */
export function commandAccess(deps: Pick<AgentDeps, 'conn' | 'session' | 'run_id' | 'work_order'>): () => AccessMode {
  const decide = commandAccessDecision(deps)
  return () => decide().effective
}

/** The paths a read-only command may not write, as the sandbox names them for the workspace: its root (and an attached
 *  folder it could write), its Git metadata and base repository, and the attached folder itself. */
function workspaceWritePaths(o: ExecuteOptions, network: boolean): string[] {
  const box = sandboxForWorkspace(o.workspaces.settings.data_dir, o.project, o.workspace, { network, attached_write: true, attached: o.policy.attached })
  return [...box.writable, ...box.write_deny, ...(o.policy.attached ? [o.policy.attached.root] : [])]
}

/** The working folder (and an attached folder it writes) as a Full access command writes them: what a read-only folder
 *  of the session's holding them leaves writable. */
function workspaceWritablePaths(o: ExecuteOptions): string[] {
  return [resolveReal(o.workspace.path), ...(o.policy.attached?.writable ? [o.policy.attached.root] : [])]
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/')
}

/** A refused command's result: the reason, and where it was to run and why. */
function refusedResult(command: string, why: string, extra: Record<string, unknown>, access: { requested: AccessMode; effective: AccessMode; reasons: AccessReason[] } | null): [Payload, Record<string, unknown>] {
  const fields = access ? { requested_access: access.requested, effective_access: access.effective, access_reasons: access.reasons, restrictions: null } : {}
  return [{ status: 'refused', reason: why, ...extra, ...fields }, { summary: why.slice(0, 200), command: command.slice(0, 200), ...('isolation' in extra ? { isolation: extra.isolation } : {}), ...('code' in extra ? { code: extra.code } : {}) }]
}

/** The one execution path for a command — the tool's and an approved proposal's: the cwd policy, the sandbox, the
 *  logs as assets, the bounded wait; with hard locks, the tree before and after is compared and a violation is
 *  recorded in the result (a command writes where the sandbox lets it; the lock is enforced again at the
 *  checkpoint). Returns [payload, summary]. */
async function executeRemoteCommand(o: ExecuteOptions): Promise<[Payload, Record<string, unknown>]> {
  const decide = (): CommandDecision => o.decide?.() ?? { network: o.network === true, access: 'sandbox' }
  const check = (decision: CommandDecision): [Payload, Record<string, unknown>] | null => {
    if ('refused' in decision) return refusedResult(o.command, decision.refused, {}, null)
    if (decision.access !== 'full') return refusedResult(o.command, 'Remote sandbox enforcement is unavailable.', { code: 'sandbox_unavailable' }, null)
    if (!decision.network || o.read_only || o.order?.read_only || (o.order && (o.order.scope.read !== null || o.order.scope.write !== null)) || o.locks.length || o.roots?.some(r => r.access === 'read')) return refusedResult(o.command, 'The requested remote shell restrictions cannot be enforced; nothing ran.', { code: 'restriction_unavailable' }, null)
    if (o.order && !o.order.execution.commands) return refusedResult(o.command, 'This work order permits no commands.', { code: 'restriction_unavailable' }, null)
    return null
  }
  let decision = decide(), refused = check(decision)
  if (refused) return refused
  if (o.input_files && authorizedPaths(o.input_files).length) return refusedResult(o.command, 'Local attachment paths are not remote files; command attachment transfer is unavailable.', { code: 'attachment_transfer_unavailable' }, null)
  const folder = await o.workspaces.requireRemoteFiles().resolve(o.workspace, o.cwd ?? '.')
  if (folder.kind !== 'directory') return refusedResult(o.command, 'The remote working directory is not a directory.', { code: 'path_refused' }, null)
  decision = decide(); refused = check(decision)
  if (refused || 'refused' in decision) return refused!
  o.workspaces.requireRemoteFiles().ensureSettled(o.workspace)
  const execution = await o.processes.start({ project_id: o.project.id, workspace_id: o.workspace.id, run_id: o.run_id, tool_call_id: o.tool_call_id,
    command: o.command, cwd: folder.absolute_path, access: 'full', timeout_s: o.timeout_s ?? null, output_cap_bytes: null, launched_by: o.launched_by ?? null,
    remote_lease: o.workspaces.requireRemoteFiles().leaseForRun(o.run_id, o.workspace) ?? undefined,
    access_report: { requested_access: decision.requested_access ?? 'full', effective_access: 'full', access_reasons: decision.access_reasons ?? [] } })
  o.on_started?.(execution, folder.absolute_path, o.timeout_s ?? null)
  await settleRemoteStart(o, execution.id)
  await o.processes.wait(execution.id, Math.max(0, Math.min(o.wait_s ?? 120, 600)))
  const payload = await o.processes.summaryAsync(execution.id)
  return [payload, { execution_id: execution.id, command: o.command.slice(0, 200), status: payload.status, running: payload.running, target: o.workspace.target }]
}

/** The waits between asking again whether a start whose reply was lost happened (ms; the last repeats). */
const START_SETTLE_STEPS_MS = [0, 250, 500, 1000, 2000, 4000, 8000]

/** A remote start whose reply was lost is settled before anything else happens: the job's own durable record (the
 *  same operation, jobs.recover) is asked while the connection comes back, up to the settle bound. Known: the call
 *  goes on as for any start. Still unknown: RemoteOutcomeUnresolved — the command was not sent again, and the run
 *  stops (bash) before a second start could run it twice. */
async function settleRemoteStart(o: ExecuteOptions, executionId: string): Promise<void> {
  const driver = o.processes.remoteDriver
  const known = () => { const s = driver?.startIdentity?.(executionId); return !s || s.job_id !== null || s.finalized || s.refused }
  if (!driver?.recoverStart || known()) return
  const deadline = Date.now() + o.workspaces.requireRemoteFiles().settleMs
  for (let n = 1; Date.now() < deadline; n++) {
    if (o.cancelled?.()) break
    try { await driver.recoverStart(executionId) } catch { /* the connection is still away: asked again below */ }
    if (known()) return
    await new Promise(resolve => setTimeout(resolve, Math.min(START_SETTLE_STEPS_MS[Math.min(n, START_SETTLE_STEPS_MS.length - 1)]!, Math.max(0, deadline - Date.now()))))
  }
  const identity = driver.startIdentity?.(executionId)
  throw new RemoteOutcomeUnresolved(`Remote operation outcome unknown: command start (execution ${executionId}, operation ${identity?.operation_id ?? 'unknown'}); not sent again.`,
    { kind: 'job_start', operation_id: identity?.operation_id ?? '', target_id: o.workspace.target?.kind === 'ssh' ? o.workspace.target.target_id : '', execution_id: executionId, receipt_state: 'unknown' })
}

export async function executeCommand(o: ExecuteOptions): Promise<[Payload, Record<string, unknown>]> {
  if (o.workspace.target?.kind === 'ssh') return executeRemoteCommand(o)
  const root = resolveReal(o.workspace.path)
  let workdir = root
  const command = o.command
  const waitS = o.wait_s ?? 120
  const readOnly = o.read_only === true
  const roots = (o.roots ?? []).filter((r) => r && typeof r.path === 'string' && r.path.length > 0)
  const readRoots = roots.filter((r) => r.access !== 'write').map((r) => r.path)
  const writeRoots = roots.filter((r) => r.access === 'write').map((r) => r.path)
  if (o.cwd) {
    try {
      ;[, workdir] = o.policy.resolveRead(o.cwd)
    } catch (error) {
      const reason = `cwd: ${(error as Error).message}`
      return [{ status: 'refused', reason }, { summary: reason.slice(0, 200), command: command.slice(0, 200) }]
    }
    let isDir = false
    try { isDir = statSync(workdir).isDirectory() } catch { isDir = false }
    if (!isDir) {
      const reason = `cwd '${o.cwd}' is not a directory`
      return [{ status: 'refused', reason }, { summary: reason, command: command.slice(0, 200) }]
    }
  }
  const baseRepo = o.workspaces.repoOf(o.workspace)
  // a workspace of the earlier layout is taken into a repository of its own before anything runs in it
  await o.workspaces.adopt(o.workspace, o.project)
  // the person's folder has no tree of the harness's to compare after the command: what a hard lock holds is refused
  // to the command's writes before it runs (the kernel's write deny), the whole file — a lock on a line of it too
  const inPlace = isDirect(o.workspace)
  const lockedFiles = inPlace ? o.locks.map((l) => l.path).filter((p) => !/[*?[]/.test(p)).map((p) => join(root, p)) : []
  // a read-only command writes no tree: nothing of it to compare (another writer may change the tree meanwhile)
  const treeBefore = o.locks.length && !inPlace && !readOnly ? (await o.workspaces.git.snapshotTree(root, o.workspace.base_commit)).tree_sha : null
  // the session's uploads the command may read (exact literal reads); a refused one stays denied, and is said
  const inputRefused = o.input_files?.refused ?? []
  if (inputRefused.length) o.on_input_refused?.(inputRefused)
  let execution: Execution
  let timeout: number | null = null
  let access: AccessMode = 'sandbox'
  let requested: AccessMode = 'sandbox'
  const reasons: AccessReason[] = []
  try {
    // decided now, with nothing awaited between this reading and the start (which counts the command as the session's
    // at once): no change of mode, grant, gate or access lands in between (api/gate.ts)
    const decision: CommandDecision = o.decide ? o.decide() : { network: !!o.network, access: 'sandbox' }
    if ('refused' in decision) return [{ status: 'refused', reason: decision.refused }, { summary: decision.refused.slice(0, 200), command: command.slice(0, 200) }]
    const network = decision.network
    access = decision.access
    requested = decision.requested_access ?? access
    reasons.push(...(decision.access_reasons ?? []))
    // the restrictions chosen for this command, each said; with Full access the OS holds them on the host, nothing more
    if (!network) reasons.push(reason('network_off'))
    if (lockedFiles.length) reasons.push(reason('hard_lock', `${lockedFiles.length} file(s) under a hard lock in the folder edited in place are denied writes by the OS: ${lockedFiles.map((f) => relative(root, f)).join(', ')}.`))
    if (readOnly) reasons.push(reason('read_only'))
    else if (readRoots.length) reasons.push(reason('read_only_root', `Folders the session holds with read access are denied writes by the OS: ${readRoots.join(', ')}.`))
    // the deadline: the call's own; else the configured one (none for Full access unless configured)
    const given = o.timeout_s ? Math.trunc(o.timeout_s) : null
    const configured = access === 'full' ? (o.config.full_access_command_timeout_s ?? null) : o.config.command_timeout_s
    timeout = given ?? configured
    const cap = access === 'full' ? (o.config.full_access_output_cap_bytes ?? null) : o.config.command_output_cap_bytes
    let box: Sandbox | undefined
    let host: HostRestrictions | null = null
    if (access === 'full') {
      const orderFs = orderFilesystemBounds(o.order ?? null)
      // the session's read-only folders (all of its folders for a read-only command) denied; a writable folder of the
      // session's — or the working folder — lying inside a read-only one stays writable (the deepest folder decides,
      // as for the file tools: workspace/paths.ts), a read-only one inside that denied again
      const nestedWritable = readOnly ? [] : [...writeRoots, ...workspaceWritablePaths(o)].filter((w) => readRoots.some((r) => r !== w && inside(w, r)))
      host = {
        network,
        write_deny: [...lockedFiles, ...(readOnly ? [...workspaceWritePaths(o, network), ...roots.map((r) => r.path)] : readRoots)],
        ...(nestedWritable.length ? { write_allow: nestedWritable } : {}),
        // a work order's read-only / scope bounds as the sandbox renders them (the protected paths stay the file tools')
        bounds: orderFs ? sandboxForWorkspace(o.workspaces.settings.data_dir, o.project, o.workspace, {
          network, attached_write: o.policy.attached?.writable === true, attached: o.policy.attached, order: { ...orderFs, protected: [] },
        }).bounds ?? null : null,
      }
    } else {
      const bounds = orderBounds(o.order ?? null, o.policy)
      // the session's folders as the sandbox renders them (workspace/sandbox.ts withRoots): a write one writable (its
      // nested Git metadata not), a read one read as any folder outside the denied places and never written — nothing
      // is added to read_allow, so a credential store inside a folder stays denied; a read-only command writes none
      box = sandboxForWorkspace(o.workspaces.settings.data_dir, o.project, o.workspace, {
        network, attached_write: o.policy.attached?.writable === true, order: readOnly ? { ...bounds, read_only: true } : bounds, attached: o.policy.attached,
        deny_write: lockedFiles, input_files: o.input_files ?? null, roots: readOnly ? null : roots,
      })
      // denied after sandboxForWorkspace (which drops deny_write for a managed workspace): every folder of a read-only
      // command's
      if (readOnly && roots.length) box = { ...box, write_deny: [...box.write_deny, ...roots.map((r) => r.path)] }
    }
    execution = await o.processes.start({
      command, cwd: workdir, access, sandbox: box, host_restrictions: host,
      project_id: o.project.id, run_id: o.run_id, workspace_id: o.workspace.id, tool_call_id: o.tool_call_id, kind: 'command', launched_by: o.launched_by ?? null,
      timeout_s: timeout, ...(timeout !== null ? { timeout_source: given !== null ? 'call' as const : 'config' as const } : {}), output_cap_bytes: cap,
      env_passthrough: [...o.config.command_env_passthrough],
      // a read-only command's git skips its optional index refresh (a write the OS would refuse) rather than fail it
      ...(readOnly && access === 'full' ? { env_extra: { GIT_OPTIONAL_LOCKS: '0' } } : {}),
      access_report: { requested_access: requested, effective_access: access, access_reasons: [...reasons] },
    })
  } catch (error) {
    const decided = { requested, effective: access, reasons: [...reasons] }
    if (error instanceof HostShellRefused) return refusedResult(command, error.message, { isolation: 'none' }, decided)
    if (error instanceof HostRestrictionUnavailable) {
      return refusedResult(command, error.message, { isolation: 'unavailable', code: 'restriction_unavailable' }, { ...decided, reasons: [...decided.reasons, reason('restriction_unavailable', error.message)] })
    }
    if (error instanceof IsolationUnavailable) {
      return refusedResult(command, error.message, { isolation: 'unavailable', code: 'sandbox_unavailable' }, { ...decided, reasons: [...decided.reasons, reason('sandbox_unavailable', error.message)] })
    }
    const message = (error as Error).message ?? String(error)
    return refusedResult(command, message, {}, reasons.length || o.decide ? decided : null)
  }
  if (!readOnly) o.workspaces.noteWrite(o.workspace) // a command may write anything inside the workspace
  if (o.on_started) o.on_started(execution, workdir, timeout)
  await o.processes.wait(execution.id, Math.min(Math.max(1, Math.trunc(waitS)), MAX_WAIT_S))
  const summary = o.processes.summary(execution.id)
  if (summary.running) {
    summary.status = 'running'
    // still running, and — when a cap or a failed log write kept less than it wrote — that too
    summary.note = [text('result.running', { execution_id: execution.id }), summary.output_complete === false ? summary.note : null].filter(Boolean).join(' ')
  } else if (o.locks.length && !inPlace && !readOnly) {
    const treeAfter = (await o.workspaces.git.snapshotTree(root, o.workspace.base_commit)).tree_sha
    const violations = await checkTree(o.workspaces.git, baseRepo, treeBefore!, treeAfter, o.locks)
    if (violations.length) {
      // found after the fact: the command ran and changed what a lock holds; nothing prevented it
      summary.lock_violations = violations
      summary.note = text('result.lock_changed', { paths: violations.join('; ') })
    }
  }
  const payload = { ...summary, command, ...(inputRefused.length ? { attachment_access_refused: inputRefused.map((r) => ({ ...r })) } : {}) }
  const violations = summary.lock_violations as string[] | undefined
  return [payload, {
    command: command.slice(0, 200), execution_id: execution.id, exit_code: summary.exit_code, duration_ms: summary.duration_ms,
    truncated: summary.truncated_at_cap, stdout_bytes: summary.stdout_bytes, stderr_bytes: summary.stderr_bytes,
    effective_access: summary.effective_access,
    ...(violations?.length ? { lock_violations: violations.length } : {}),
    ...(inputRefused.length ? { attachment_access_refused: inputRefused.length } : {}),
  }]
}

export async function bash(ctx: Ctx, args: { command: string; timeout_s: number | null; wait_s: number; cwd: string | null }): Promise<Payload> {
  const deps = ctx.deps
  const session = refreshSession(deps)
  const command = args.command
  if (!command || !command.trim()) return refused(ctx, 'bash', 'command is required')
  const blocked = orderRefused(ctx, 'bash')
  if (blocked !== null) return blocked
  // the folders whose instruction files the first message only named: shown before any command, which can reach them
  // held while any folder's rules are on their way to the model and not in front of it yet — noted by this call, or by
  // an earlier call of the same response: a command can reach any folder, whatever its cwd
  noteUndeliveredInstructions(ctx, MAX_DISCOVERED_FILES)
  const unread = pendingScopes(deps)
  if (unread.length) {
    const payload = { status: 'deferred', tool: 'bash', reason: text('refusal.command_instructions', { scopes: unread.join(', ') }) }
    return finish(ctx, 'bash', payload, { summary: `held: the instructions for ${unread.join(', ')} are in this message`, command: command.slice(0, 200) })
  }
  // a command run in a folder: the folder's instructions come first, the command waits until they are read
  if (args.cwd) {
    let pendingScope: string | null = null
    if (deps.workspace.target?.kind === 'ssh') pendingScope = await noteRemoteInstructions(ctx, args.cwd.replace(/\/$/, '') + '/_')
    else try { const [pure, real] = deps.policy.resolveRead(args.cwd); pendingScope = noteFolderInstructions(ctx, pure, real) } catch { /* executeCommand refuses it with the reason */ }
    const held = heldForInstructions(ctx, 'bash', pendingScope)
    if (held !== null) return held
  }
  // the network follows the session's grant (on by default) and the order; a command never asks for it
  const network = commandNetwork(session.grants, deps.work_order)
  const access = commandAccessDecision(deps)
  // the first Full access command on a machine not confirmed for it waits for the person's word, in the conversation —
  // before any approval card: a card approved runs the command with the access it pinned, and asks nothing more
  if (access().effective === 'full' && !fullAccessConfirmed(deps.conn, deps.config.full_access_confirmed, deps.workspace.target?.kind === 'ssh' ? deps.workspace.remote ?? undefined : undefined)) {
    const asked = await askFullAccess(ctx)
    if (asked === 'sandbox' && deps.workspace.target?.kind === 'ssh') return refused(ctx, 'bash', 'Full access was not confirmed for this SSH target; remote sandbox enforcement is unavailable.', { code: 'sandbox_unavailable' })
    if (asked === null) {
      const why = 'the run was stopped while it waited for the person to choose where commands run; nothing ran'
      return finish(ctx, 'bash', { status: 'refused', reason: why }, { summary: why.slice(0, 200), command: command.slice(0, 200) })
    }
  }
  // the proposal pins the access and the network apart: approved, it runs no wider than either (the network off is
  // held on the host, not by moving the command into the sandbox)
  const proposed = await checkActionGate(ctx as never, 'bash', { command, timeout_s: args.timeout_s, wait_s: args.wait_s, cwd: args.cwd }, { network, attached_write: deps.policy.attached?.writable === true, access_mode: access().effective })
  if (proposed !== null) return proposed
  const granted = session.grants.run_commands
  const gate = deps.gate.check(session, 'run_command', { command }, { run_id: deps.run_id, tool_call_id: ctx.tool_call_id })
  if (gate !== null) {
    deps.emit('action_gated', { tool: 'bash', tool_call_id: ctx.tool_call_id, ...gate })
    return finish(ctx, 'bash', gate as unknown as Payload, { summary: gate.reason.slice(0, 200), command: command.slice(0, 200) })
  }
  const started = (execution: Execution, workdir: string, timeout: number | null) => {
    deps.produced.executions.push(execution.id)
    const root = deps.workspace.target?.kind === 'ssh' ? deps.workspace.path : resolveReal(deps.workspace.path)
    const record = execution.isolation as Record<string, unknown>
    deps.emit('execution_started', {
      tool_call_id: ctx.tool_call_id, execution_id: execution.id, command, cwd: workdir === root ? '.' : workdir.startsWith(root + '/') ? relative(root, workdir) : workdir,
      network: execution.network, timeout_s: timeout,
      requested_access: record.requested_access ?? null, effective_access: record.effective_access ?? null, access_reasons: record.access_reasons ?? [], restrictions: record.restrictions ?? null,
    })
  }
  const [payload, summary] = await executeCommand({
    processes: deps.processes, workspaces: deps.workspaces, config: deps.config, project: deps.project, workspace: deps.workspace, policy: deps.policy,
    locks: deps.locks(), run_id: deps.run_id, tool_call_id: ctx.tool_call_id, command, timeout_s: args.timeout_s, wait_s: args.wait_s, network,
    cwd: args.cwd, on_started: started, order: deps.work_order, roots: deps.policy.roots, cancelled: deps.cancelled, launched_by: 'run',
    // at the start: still allowed (a per-call approval just consumed stands in for the grant), the network and access
    decide: () => {
      // the run was stopped while this call waited (the folder's adoption, a lock's tree): nothing starts for it
      if (deps.cancelled()) return { refused: 'the run was stopped before the command started; nothing ran' }
      const refused = commandRefusedNow(deps.conn, deps.session.id, { run_id: deps.run_id, parent_run_id: (deps as { parent_run_id?: string | null }).parent_run_id ?? null, approved: { grant: !granted } })
      if (refused !== null) return { refused }
      const now = repo.getSession(deps.conn, deps.session.id)!
      const decided = access()
      return { network: commandNetwork(now.grants, deps.work_order), access: decided.effective, requested_access: decided.requested, access_reasons: decided.reasons }
    },
    input_files: sessionInputFiles(deps.conn, deps.store, deps.workspaces.settings.data_dir, deps.session),
    on_input_refused: (list) => { for (const r of list) deps.emit('attachment_refused', { scope: 'command', tool_call_id: ctx.tool_call_id, asset_id: r.asset_id, reason: r.reason }) },
  }).catch((error: unknown) => {
    // a start whose outcome stays unknown is no result: the run stops here (no later call, no request)
    if (error instanceof RemoteOutcomeUnresolved) haltOnUnresolved(ctx, 'bash', error)
    throw error
  })
  const violations = payload.lock_violations as string[] | undefined
  if (violations?.length) {
    deps.lock_violations += violations.length
    deps.emit('lock_violation', { tool_call_id: ctx.tool_call_id, execution_id: payload.execution_id, violations })
  }
  return finish(ctx, 'bash', payload, summary)
}

/** The harness's question before the first Full access command: written, waited on and announced in one synchronous
 *  stretch (as request_input), answered in the conversation. Sandbox (or a decline) sets the session to the sandbox,
 *  as the person's choice; full confirms the machine (this Mac, or the SSH host) and answers the same question waiting
 *  elsewhere for it. Null: the run
 *  was stopped meanwhile. */
async function askFullAccess(ctx: Ctx): Promise<'full' | 'sandbox' | null> {
  const deps = ctx.deps
  const remote = deps.workspace.target?.kind === 'ssh' ? deps.workspace.remote : null
  const pending = repo.insertUiInput(deps.conn, { session_id: deps.session.id, run_id: deps.run_id, tool_call_id: ctx.tool_call_id, request: fullAccessRequest(remote ? { ...remote, label: deps.workspaces.requireRemoteFiles().remote.target(remote.target_id).label } : undefined) })
  const answered = awaitAnswer(deps.conn, pending.id, deps.cancel_signal, deps.stop_reason)
  deps.emit('ui_input', { input: pending })
  const record = await answered
  deps.emit('ui_input', { input: record })
  if (record.status === 'closed') return null
  if (record.status === 'submitted' && record.values?.access === 'full') {
    answerOtherFullAccessAsks(deps.conn, record.id, remote ? remote.target_id : null)
    return 'full'
  }
  if (remote) return 'sandbox' // decline refuses this call; it never installs a fictitious remote sandbox
  repo.setSessionAccess(deps.conn, deps.session.id, 'sandbox')
  repo.logGovernance(deps.conn, deps.session.id, 'session_access', { actor: 'user', params: { access_mode: 'sandbox', previous: 'full', asked: record.id }, run_id: deps.run_id })
  return 'sandbox'
}

/** The execution as this run may read and stop it: its own, one of its workspace's, or one a run of its session
 *  started (a session's runs share their commands: a later run reads what an earlier one left running). Another
 *  session's command — another project's, another person's task — is not this run's, however its id was learnt:
 *  null, and the tool answers as for an id that names nothing. */
export function ownedExecution(deps: AgentDeps, executionId: string): Execution | null {
  const execution = repo.getExecution(deps.conn, executionId)
  if (execution === null) return null
  if (execution.run_id === deps.run_id || (execution.workspace_id !== null && execution.workspace_id === deps.workspace.id)) return execution
  if (execution.run_id !== null && repo.getRun(deps.conn, execution.run_id)?.session_id === deps.session.id) return execution
  if (execution.workspace_id !== null && repo.getWorkspace(deps.conn, execution.workspace_id)?.session_id === deps.session.id) return execution
  return null
}

export async function bashOutput(ctx: Ctx, args: { execution_id: string; stream: 'stdout' | 'stderr'; offset: number; limit: number }): Promise<Payload> {
  const deps = ctx.deps
  if (ownedExecution(deps, args.execution_id) === null) return refused(ctx, 'bash_output', `unknown command ${args.execution_id}`)
  let window
  try {
    window = await deps.processes.readOutputAsync(args.execution_id, args.stream, Math.max(0, Math.trunc(args.offset)), Math.max(1, Math.min(Math.trunc(args.limit), 65536)))
  } catch {
    return refused(ctx, 'bash_output', `unknown command ${args.execution_id}`)
  }
  const payload = Object.assign({ status: 'ok' }, window) as Payload
  return finish(ctx, 'bash_output', payload, { execution_id: args.execution_id, stream: args.stream, offset: args.offset, returned_bytes: window.returned_bytes, running: window.running })
}

export async function stopCommand(ctx: Ctx, args: { execution_id: string }): Promise<Payload> {
  if (ownedExecution(ctx.deps, args.execution_id) === null) return refused(ctx, 'stop_command', `unknown command ${args.execution_id}`)
  if (ctx.deps.processes.isRemoteExecution(args.execution_id)) {
    const result = await ctx.deps.processes.stopAsync(args.execution_id)
    const stopped = repo.getExecution(ctx.deps.conn, args.execution_id)?.cancelled === true && !ctx.deps.processes.isRunning(args.execution_id)
    return finish(ctx, 'stop_command', { ...result, execution_id: args.execution_id, stopped, status: result.state ?? 'unknown' }, { execution_id: args.execution_id, stopped })
  }
  const stopped = ctx.deps.processes.stop(args.execution_id)
  const payload = { status: stopped ? 'ok' : 'not_running', execution_id: args.execution_id, stopped }
  return finish(ctx, 'stop_command', payload, { execution_id: args.execution_id, stopped })
}

register({
  name: 'bash', effect: 'isolated_code_execution', action: 'run_command', renderer: 'command', summary: 'run a shell command in the working folder',
  description: PROMPT_TEXT['tool.bash'],
  schema: z.object({
    command: z.string().describe(PROMPT_TEXT['parameter.bash.command']),
    cwd: z.string().nullable().default(null).describe(PROMPT_TEXT['parameter.bash.cwd']),
    timeout_s: z.number().int().nullable().default(null).describe(PROMPT_TEXT['parameter.bash.timeout_s']),
    wait_s: z.number().int().default(120).describe(PROMPT_TEXT['parameter.bash.wait_s']),
  }), fn: bash,
})
register({
  name: 'bash_output', effect: 'read', action: null, renderer: 'process_output', summary: "read a command's saved output",
  description: PROMPT_TEXT['tool.bash_output'],
  schema: z.object({
    execution_id: z.string().describe(PROMPT_TEXT['parameter.bash_output.execution_id']),
    stream: z.enum(['stdout', 'stderr']).default('stdout').describe(PROMPT_TEXT['parameter.bash_output.stream']),
    offset: z.number().int().default(0).describe(PROMPT_TEXT['parameter.bash_output.offset']),
    limit: z.number().int().default(16384).describe(PROMPT_TEXT['parameter.bash_output.limit']),
  }), fn: bashOutput,
})
register({
  name: 'stop_command', effect: 'state_change', action: null, renderer: 'generic', summary: 'stop a running command',
  description: PROMPT_TEXT['tool.stop_command'],
  schema: z.object({ execution_id: z.string().describe(PROMPT_TEXT['parameter.stop_command.execution_id']) }), fn: stopCommand,
})

/** An approved command's access, and why: read when it starts, from the session, the proposing run's cap, its order,
 *  the pin and the request approving it. */
export function approvedAccessDecision(conn: AgentDeps['conn'], sessionId: string, runId: string | null, order: WorkOrder | null, pinned: PinnedPermissions | null): () => AccessDecision {
  const request = currentRequestCap()
  return () => {
    const session = repo.getSession(conn, sessionId)
    if (session === null) return { requested: 'sandbox', effective: 'sandbox', reasons: [] }
    return accessDecision({ session, run_cap: runId ? repo.runAccessCap(conn, runId) : null, order, pinned: pinned?.access_mode ?? 'sandbox', request })
  }
}

/** An approved command's access (approvedAccessDecision's). */
export function approvedAccess(conn: AgentDeps['conn'], sessionId: string, runId: string | null, order: WorkOrder | null, pinned: PinnedPermissions | null): () => AccessMode {
  const decide = approvedAccessDecision(conn, sessionId, runId, order, pinned)
  return () => decide().effective
}

// an approved command runs as the proposing run would have run it: under its work order's boundaries, with the
// network the session and the order give it now and no more than it had when proposed, the attached folder likewise
setGateHooks({ executors: { bash: async (host, args, ctx) => {
  const session = repo.getSession(host.conn, ctx.session.id)
  if (session === null) throw new Error(`session ${ctx.session.id} is gone`)
  const grants = session.grants
  const attachedWrite = grants.attached_write && (ctx.pinned === null || ctx.pinned.attached_write)
  const [result] = await executeCommand({
    processes: (host as unknown as { processes: ProcessManager }).processes, workspaces: host.workspaces,
    config: host.config as unknown as HarnessConfig, project: ctx.project, workspace: ctx.workspace,
    policy: ctx.workspace.target?.kind === 'ssh' ? new RemotePathPolicy(ctx.workspace, ctx.protected) : PathPolicy.forWorkspace(ctx.workspace.path, ctx.protected, workspaceAttached(ctx.project, ctx.workspace, { writable: attachedWrite }), { temp: ctx.temp, pinned: isDirect(ctx.workspace), ...rootPolicyOptions(session, ctx.workspace) }),
    roots: rootPolicyOptions(session, ctx.workspace).roots,
    locks: ctx.locks, run_id: ctx.run_id, tool_call_id: ctx.tool_call_id,
    command: args.command as string, timeout_s: args.timeout_s as number | null, wait_s: args.wait_s as number,
    network: commandNetwork(grants, ctx.order, ctx.pinned), cwd: args.cwd as string | null, order: ctx.order,
    on_started: ctx.on_started ?? null, launched_by: 'approval',
    // at the start: the person approved this very call (it stands in for the grant and the gate), but Plan holds; no
    // more than it was proposed with (a proposal from before access modes: the sandbox), the session, the run's cap,
    // the order and the approving request allow
    decide: () => {
      const refused = commandRefusedNow(host.conn, ctx.session.id, { run_id: ctx.run_id, approved: { grant: true, gate: true } })
      if (refused !== null) return { refused }
      const now = repo.getSession(host.conn, ctx.session.id)!
      const decided = approvedAccessDecision(host.conn, ctx.session.id, ctx.run_id, ctx.order, ctx.pinned)()
      // a card proposed before its machine confirmed Full access (the question now comes before any card) never runs as
      // the person on that word alone
      if (decided.effective === 'full' && !fullAccessConfirmed(host.conn, (host.config as unknown as HarnessConfig).full_access_confirmed, ctx.workspace.target?.kind === 'ssh' ? ctx.workspace.remote ?? undefined : undefined)) {
        return { refused: 'Full access is not confirmed on this computer: nothing ran. The next Full access command asks for it.' }
      }
      return { network: commandNetwork(now.grants, ctx.order, ctx.pinned), access: decided.effective, requested_access: decided.requested, access_reasons: decided.reasons }
    },
    // the result carries what was refused (attachment_access_refused): the approving person and the run read it there
    input_files: sessionInputFiles(host.conn, host.store, host.workspaces.settings.data_dir, session),
  })
  return result
} } })
