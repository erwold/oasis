/** The Action Gate (adapted from oasis agent/gate.py, see NOTICE) — materialize the agent's NEXT write for a
 *  person's review.
 *
 *  When the session's run control gates an action, the already-validated tool call is persisted as an immutable
 *  proposal (a report asset, role agent_action_proposal), the model receives a structured `action_gated` result and
 *  winds the run down, and the proposal lands in the person's review queue. Approval executes through the SAME
 *  write path the tool would have used (the path policy, the hash precondition, the hard locks, the sandbox, the
 *  integration checks all still apply) after the base the proposal was made against is checked for drift;
 *  rejection hands the agent a structured refusal to replan around. Nothing pauses a coroutine across processes —
 *  the continuation is a fresh run that reads the decisions.
 *
 *  Run control, session locks and decisions are append-only entries of the governance log; the effective control
 *  is DERIVED from the latest matching entry, never stored as mutable state. This gate is separate from the session
 *  grants (policy/permissions.ts): a grant says what a session may do without asking; the gate lets a person pause
 *  before an effect even when a grant would allow it. */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z, computerActSchema, PROPOSAL_SCHEMA, WorkOrderShapeSchema, type LockSpec, type Project, type WorkOrder, type Workspace } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import type { AssetStore } from '../store.ts'
import type { WorkspaceService } from '../workspace/service.ts'
import { holderEnds, WorkspaceBusy, type WorkspaceLocks } from '../workspace/locks.ts'
import { LockSpecSchema } from './locks.ts'
import { text } from '../prompt_texts.ts'
import type { AccessMode } from '@oasis-code/contract/modes'
import { currentRequestCap } from './access.ts'

export { PROPOSAL_SCHEMA }
export const PROPOSAL_ROLE = 'agent_action_proposal'
export const CONTROL = 'run_control'
export const DECISION = 'proposal_decision'
export const LOCKS = 'session_locks'
export const EFFECT_TAGS = new Set(['read', 'compute', 'workspace_write', 'isolated_code_execution', 'state_change', 'network'])
// Tools the gate can both intercept AND execute on approval (a proposal nobody can approve is worse than none).
export const GATEABLE_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'computer_act'])

export const WriteArgs = z.object({ path: z.string(), content: z.string() })
export const EditArgs = z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().default(false) })
export const CommandArgs = z.object({
  command: z.string(), timeout_s: z.number().int().nullable().default(null), wait_s: z.number().int().default(120),
  cwd: z.string().nullable().default(null),
})

export const ARG_MODELS: Record<string, z.ZodType> = { write_file: WriteArgs, edit_file: EditArgs, bash: CommandArgs, computer_act: computerActSchema() }

/** What the tools layer provides once it is loaded: each tool's effect, the tool-result finisher, and the executors
 *  a decision runs through. The registry sets these on import; the gate never imports the tools itself. */
export interface GateHooks {
  effectOf: (toolName: string) => string | null
  finish: (ctx: GateContext, toolName: string, result: Record<string, unknown>, summary: string) => Record<string, unknown>
  executors: Record<string, (host: GateHost, args: Record<string, unknown>, ctx: ExecutionContext) => Promise<Record<string, unknown>>>
  recordHumanRun: (conn: Conn, opts: Record<string, unknown>) => void
}

const hooks: GateHooks = {
  effectOf: () => null,
  finish: (_ctx, _tool, result) => result,
  executors: {},
  recordHumanRun: () => {},
}

export function setGateHooks(partial: Partial<GateHooks>): void {
  const { executors, ...rest } = partial
  Object.assign(hooks, rest)
  if (executors) Object.assign(hooks.executors, executors)
}

export function effectsFor(toolName: string): Set<string> {
  return new Set([hooks.effectOf(toolName) ?? 'state_change'])
}

// -- run control (append-only, derived) ---------------------------------------

export function recordRunControl(conn: Conn, sessionId: string, desiredState: string, gateEffects: string[] | null = null, runId: string | null = null, actor: 'user' | 'director' | 'agent' = 'user'): number {
  if (desiredState !== 'run' && desiredState !== 'pause') throw new Error("desired_state must be 'run' or 'pause'")
  const effects = [...(gateEffects ?? [])]
  const unknown = effects.filter((e) => !EFFECT_TAGS.has(e))
  if (unknown.length) throw new Error(`unknown gate effects: ${JSON.stringify(unknown)}`)
  return repo.logGovernance(conn, sessionId, CONTROL, { actor, run_id: runId, params: { desired_state: desiredState, gate_effects: effects, run_id: runId } })
}

export interface RunControl { desired_state: string; gate_effects: string[]; entry_id?: number; run_id?: string | null }

/** The latest control entry scoped to this run (or its parent, for a child run) or session-wide. */
export function effectiveControl(conn: Conn, sessionId: string, runId: string | null = null, parentRunId: string | null = null): RunControl {
  for (const entry of repo.listGovernance(conn, sessionId, CONTROL)) {
    const scope = (entry.params.run_id as string | null | undefined) ?? null
    if (scope === null || scope === runId || scope === parentRunId) {
      return { desired_state: entry.params.desired_state as string, gate_effects: (entry.params.gate_effects as string[]) ?? [], entry_id: entry.id, run_id: scope }
    }
  }
  return { desired_state: 'run', gate_effects: [] }
}

export function shouldGate(effects: Set<string>, control: RunControl): boolean {
  if (control.desired_state !== 'pause') return false
  if ([...effects].every((e) => e === 'read')) return false // observation is never gated
  const gateEffects = new Set(control.gate_effects ?? [])
  if (!gateEffects.size) return true // pause at the next non-read action
  return [...effects].some((e) => gateEffects.has(e))
}

// -- session locks (append-only, derived) -------------------------------------

export function recordLocks(conn: Conn, sessionId: string, locks: unknown[]): number {
  const parsed = locks.map((lock) => LockSpecSchema.parse(lock))
  return repo.logGovernance(conn, sessionId, LOCKS, { actor: 'user', params: { locks: parsed } })
}

export function sessionLocks(conn: Conn, sessionId: string): LockSpec[] {
  const entries = repo.listGovernance(conn, sessionId, LOCKS)
  return entries.length ? ((entries[0]!.params.locks as unknown[]) ?? []).map((l) => LockSpecSchema.parse(l)) : []
}

/** The locks every write of a run is checked against: the session's, the project's config (`locks`), the order's. */
export function effectiveLocks(conn: Conn, sessionId: string, project: Project | null, order: { locks?: LockSpec[] } | null = null): LockSpec[] {
  const locks = sessionLocks(conn, sessionId)
  for (const raw of ((project?.config.locks as unknown[] | undefined) ?? [])) {
    const parsed = LockSpecSchema.safeParse(raw)
    if (parsed.success) locks.push(parsed.data)
  }
  if (order) locks.push(...(order.locks ?? []))
  return locks
}

// -- proposals ---------------------------------------------------------------

/** Validate against the SAME shapes the write path takes; an invalid call never becomes a proposal. */
export function validateArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const model = ARG_MODELS[toolName]
  if (model === undefined) throw new Error(`tool '${toolName}' is not gateable`)
  const validated = model.parse(args) as Record<string, unknown>
  if (toolName === 'bash' && !String(validated.command).trim()) throw new Error('the command is empty')
  return validated
}

async function fileSha(workspaces: WorkspaceService, workspace: Workspace, rel: string): Promise<string | null> {
  if (workspace.target?.kind === 'ssh') {
    const bytes = await workspaces.requireRemoteFiles().now(workspace, rel)
    return bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
  }
  const path = join(workspace.path, rel)
  try {
    if (!statSync(path).isFile()) return null
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** Pin what the proposal was made AGAINST: the workspace's tree, and for a file write the file's bytes. A folder
 *  edited in place has no tree of the harness's to pin (reading one would hash the whole folder): the file's bytes
 *  alone — a command there is proposed against the folder as it lives. */
async function fingerprints(workspaces: WorkspaceService, workspace: Workspace, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const prints: Record<string, unknown>[] = workspace.kind === 'direct' ? [] : [{ kind: 'workspace_tree', id: workspace.id, tree_sha: (await workspaces.git.snapshotTree(workspace.path, workspace.base_commit)).tree_sha }]
  if (workspace.target?.kind === 'ssh') prints.push({ kind: 'remote_root', target: workspace.target, remote: workspace.remote })
  if (toolName === 'write_file' || toolName === 'edit_file') prints.push({ kind: 'file', id: args.path, sha256: await fileSha(workspaces, workspace, args.path as string) })
  return prints
}

/** What the gate needs from a tool call's context (the tool's deps, as the tools layer builds them). */
export interface GateContext {
  tool_call_id: string
  deps: {
    conn: Conn
    session: { id: string }
    run_id: string
    parent_run_id?: string | null
    workspace?: Workspace
    project?: Project
    workspaces?: WorkspaceService
    store?: AssetStore
    emit?: (event: string, data: Record<string, unknown>) => void
  }
}

/** What a proposed command would have run with, pinned at the proposal: an approval runs it with no more than this
 *  (and no more than the session and the order allow at that moment) — a grant widened in between widens nothing. */
export interface PinnedPermissions {
  network: boolean; attached_write: boolean
  /** a command's access when it was proposed (schema v28); a proposal from before access modes: the sandbox */
  access_mode?: AccessMode
}

/** Called by a gateable tool before doing anything (after the work order's refusal, before the session grant): the
 *  structured `action_gated` payload for the model, or null to proceed. `pinned` is what the call would run with
 *  now (a command's network, its attached-folder write), kept on the proposal for its approval; `context` is what the
 *  tool knows beside the arguments that the person judges the action by, and its approval may need (a computer
 *  action's dialog, how its network was let through). */
export async function checkActionGate(ctx: GateContext, toolName: string, args: Record<string, unknown>, pinned: PinnedPermissions | null = null, context: Record<string, unknown> | null = null): Promise<Record<string, unknown> | null> {
  const deps = ctx.deps
  if (!GATEABLE_TOOLS.has(toolName)) return null
  const effects = effectsFor(toolName)
  const control = effectiveControl(deps.conn, deps.session.id, deps.run_id, deps.parent_run_id ?? null)
  if (!shouldGate(effects, control)) return null
  const validated = validateArgs(toolName, args)
  const payload = {
    schema_version: PROPOSAL_SCHEMA, run_id: deps.run_id, session_id: deps.session.id, workspace_id: deps.workspace!.id,
    tool_name: toolName, tool_call_id: ctx.tool_call_id, validated_args: validated, effects: [...effects].sort(),
    estimated_cost: { usd: null, known: false },
    base_fingerprints: await fingerprints(deps.workspaces!, deps.workspace!, toolName, validated),
    pinned: pinned ?? null, context: context ?? null,
    reason: `gated by run control: pause before ${control.gate_effects.length ? JSON.stringify(control.gate_effects) : 'any action'}`,
  }
  const label = actionLabel(toolName, validated, context)
  const asset = deps.store!.save(deps.conn, deps.project!.id, 'report', JSON.stringify(payload, null, 1), {
    ext: 'json', meta: { role: PROPOSAL_ROLE, schema: PROPOSAL_SCHEMA, tool_name: toolName, run_id: deps.run_id, session_id: deps.session.id, label },
  })
  deps.emit?.('action_gated', { tool: toolName, tool_call_id: ctx.tool_call_id, status: 'action_gated', proposal_asset_id: asset.id, effects: payload.effects, reason: payload.reason })
  const result = {
    status: 'action_gated', proposal_asset_id: asset.id, effects: payload.effects,
    message: text('refusal.approval_pending', { action: label, id: asset.id }),
  }
  return hooks.finish(ctx, toolName, result, `proposed for review: ${asset.id}`)
}

/** What a proposed call is, in a few words: the tool and the path or command it names; a computer action whole. */
export function actionLabel(toolName: string, args: Record<string, unknown>, context: Record<string, unknown> | null = null): string {
  const what = typeof args.path === 'string' ? args.path : typeof args.command === 'string' ? args.command.slice(0, 80)
    : toolName === 'computer_act' ? computerActionLabel(args, context) : ''
  return what ? `${toolName} ${what}` : toolName
}

/** A value as the label quotes it: whole up to a length a person reads, marked where it is cut. */
function quoted(value: unknown, max = 300): string {
  const s = String(value)
  return JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s)
}

/** A computer action as the person approves it: what it does, to which element or point of which look, with which
 *  text or keys; a dialog's answer with the dialog the run last saw. */
export function computerActionLabel(args: Record<string, unknown>, context: Record<string, unknown> | null = null): string {
  const has = (key: string) => args[key] !== null && args[key] !== undefined && args[key] !== ''
  // a ref with what the run's look showed there (the page's own words: quoted)
  const targets = context?.targets && typeof context.targets === 'object' ? context.targets as Record<string, unknown> : {}
  const named = (ref: string) => (typeof targets[ref] === 'string' ? `${ref} (${quoted(targets[ref], 200)})` : ref)
  const at = (ref: string, x: string, y: string) => has(ref) ? named(String(args[ref])) : has(x) && has(y) ? `the point ${String(args[x])},${String(args[y])}` : ''
  const target = at('ref', 'x', 'y')
  const action = String(args.action ?? '')
  const parts: string[] = []
  switch (action) {
    case 'type':
      parts.push(`type ${quoted(args.text ?? '')}${target ? ` into ${target}` : ' into the focused field'}`)
      if (args.clear === true) parts.push('emptying the field first')
      if (args.submit === true) parts.push('then Enter')
      break
    case 'key': parts.push(`press ${quoted(args.keys ?? '')}${target ? ` at ${target}` : ''}`); break
    case 'select': parts.push(`select ${quoted(args.text ?? '')} in ${target || 'the select'}`); break
    case 'drag': parts.push(`drag ${target || 'from the middle'} to ${at('to_ref', 'to_x', 'to_y') || 'the middle'}`); break
    case 'scroll': parts.push(`scroll by ${String(args.dx ?? 0)},${String(args.dy ?? 'one page')}${target ? ` at ${target}` : ''}`); break
    case 'navigate': parts.push(`navigate to ${quoted(args.url ?? '')}`); break
    case 'upload': parts.push(`upload ${((args.files as unknown[] | null) ?? []).map((f) => quoted(f, 200)).join(', ') || 'no files'}${target ? ` into ${target}` : ' into the open file chooser'}`); break
    case 'dialog': {
      const dialog = context?.dialog && typeof context.dialog === 'object' ? context.dialog as Record<string, unknown> : null
      const seen = dialog ? ` (the ${String(dialog.type ?? 'dialog')} the run last saw: ${quoted(dialog.message ?? '')})` : ' (the run did not see which)'
      parts.push(`${args.accept === false ? 'dismiss' : 'accept'} the open dialog${seen}`)
      if (has('text') && args.accept !== false) parts.push(`answering ${quoted(args.text)}`)
      break
    }
    case 'wait': {
      const until = has('text') ? `until ${quoted(args.text)} ${args.gone === true ? 'is gone' : 'shows'}` : has('ref') ? `until ${String(args.ref)} goes`
        : has('url') ? `until the address contains ${quoted(args.url)}` : args.download === true ? 'until a download finishes' : ''
      parts.push(`wait${has('seconds') ? ` up to ${String(args.seconds)} s` : ''}${until ? ` ${until}` : ''}`)
      break
    }
    case 'back': case 'forward': case 'reload': case 'release': parts.push(action); break
    case 'tab_new': parts.push(`open a new tab${has('url') ? ` at ${quoted(args.url)}` : ''}`); break
    case 'tab_select': parts.push(`switch to tab ${quoted(args.tab_id ?? '', 80)}`); break
    case 'tab_close': parts.push(`close tab ${has('tab_id') ? quoted(args.tab_id, 80) : '(the current one)'}`); break
    default: parts.push(`${action.replace('_', ' ')} ${target || 'the page'}`)
  }
  // the tab it acts in (a tab action names its own tab already)
  const inTab = has('tab_id') && !action.startsWith('tab_') ? ` in tab ${quoted(args.tab_id, 80)}` : ''
  parts[0] = `${parts[0]} on ${String(args.surface ?? 'browser')}${inTab}`
  if (has('snapshot_id')) parts.push(`chosen on look ${String(args.snapshot_id)}`)
  return parts.join(', ')
}

export function loadProposal(conn: Conn, store: AssetStore, proposalAssetId: string): Record<string, unknown> {
  const asset = repo.getAsset(conn, proposalAssetId)
  if (asset === null || asset.meta.role !== PROPOSAL_ROLE) throw new NotFoundError(`action proposal not found: ${proposalAssetId}`)
  const payload = JSON.parse(store.read(asset.storage_path).toString('utf8')) as Record<string, unknown>
  if (payload.schema_version !== PROPOSAL_SCHEMA) throw new Error(`unsupported proposal schema: ${String(payload.schema_version)}`)
  return payload
}

export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NotFoundError' }
}

export function decisionFor(conn: Conn, proposalAssetId: string): Record<string, unknown> | null {
  const entry = repo.governanceForRef(conn, DECISION, proposalAssetId)
  return entry ? { ...entry.params, decided_at: entry.created_at } : null
}

export interface ProposalRow {
  proposal_asset_id: string; created_at: string; tool_name: string | null; run_id: string | null; session_id: string | null; status: string;
  decision: Record<string, unknown> | null
  /** what the call does, as the person reads it (a proposal made before labels were kept: its tool's name) */
  label: string | null
}

/** Proposals whose decision this process is carrying out now: a second decision on one is refused at once. */
const deciding = new Set<string>()

/** A proposal's status from its latest decision entry: an approval is written as `executing` before the action runs
 *  and again with its result after, so an `executing` entry that no process is carrying out is an approval the
 *  harness stopped in the middle of — `interrupted`, its outcome unknown, and never executed a second time. */
function statusOf(proposalAssetId: string, decision: Record<string, unknown> | null): string {
  if (decision === null) return 'pending'
  if (decision.outcome === 'executing') return deciding.has(proposalAssetId) ? 'executing' : 'interrupted'
  return decision.decision as string
}

export function listProposals(conn: Conn, projectId: string, sessionId: string | null = null): ProposalRow[] {
  const out: ProposalRow[] = []
  for (const asset of repo.listAssetsWithRole(conn, projectId, 'report', PROPOSAL_ROLE)) {
    if (sessionId !== null && asset.meta.session_id !== sessionId) continue
    const decision = decisionFor(conn, asset.id)
    out.push({
      proposal_asset_id: asset.id, created_at: asset.created_at, tool_name: (asset.meta.tool_name as string) ?? null,
      run_id: (asset.meta.run_id as string) ?? null, session_id: (asset.meta.session_id as string) ?? null,
      status: statusOf(asset.id, decision), decision, label: typeof asset.meta.label === 'string' ? asset.meta.label : null,
    })
  }
  return out
}

/** What a decision executes against: the app's shared services (the API's state satisfies it). */
export interface GateHost {
  conn: Conn
  store: AssetStore
  workspaces: WorkspaceService
  locks: Pick<WorkspaceLocks, 'holder' | 'acquire' | 'release' | 'tryAcquire' | 'busy' | 'holdUntil' | 'annotate'>
  config: { protected_paths: string[] }
}

export interface ExecutionContext {
  workspace: Workspace
  session: { id: string }
  project: Project
  protected: string[]
  locks: LockSpec[]
  run_id: string | null
  tool_call_id: string | null
  /** for a command: told when the process started, so the proposal's state carries its execution id */
  on_started?: ((execution: { id: string }) => void) | null
  /** the work order the proposing run works under: its boundaries hold for the approved call as for the run's own */
  order: WorkOrder | null
  /** what the call would have run with when it was proposed; the approval runs it with no more */
  pinned: PinnedPermissions | null
  /** the workspace's temporary folder (the one absolute location the call may name), or null */
  temp: string | null
  /** what the tool kept beside the arguments when it proposed the call (checkActionGate's `context`), or null */
  context: Record<string, unknown> | null
}

/** The work order a run row carries, as the order (null for a thread's run or an order that no longer parses). */
function orderOfRun(run: { work_order: Record<string, unknown> | null } | null): WorkOrder | null {
  if (run === null || run.work_order === null) return null
  const parsed = WorkOrderShapeSchema.safeParse(run.work_order)
  return parsed.success ? parsed.data : null
}

function pinnedOf(payload: Record<string, unknown>): PinnedPermissions | null {
  const p = payload.pinned
  if (!p || typeof p !== 'object') return null
  const { network, attached_write, access_mode } = p as Record<string, unknown>
  return { network: network === true, attached_write: attached_write === true, access_mode: access_mode === 'full' ? 'full' : 'sandbox' }
}

async function drift(host: GateHost, payload: Record<string, unknown>): Promise<string[]> {
  const out: string[] = []
  const workspace = repo.getWorkspace(host.conn, payload.workspace_id as string)
  if (workspace === null) return [`workspace ${String(payload.workspace_id)} is gone`]
  const tool = payload.tool_name as string
  const prints = (payload.base_fingerprints as Record<string, unknown>[]) ?? []
  const remotePin = prints.find(p => p.kind === 'remote_root')
  if (workspace.target?.kind === 'ssh' || remotePin) {
    if (!remotePin || JSON.stringify(remotePin.target) !== JSON.stringify(workspace.target) || JSON.stringify(remotePin.remote) !== JSON.stringify(workspace.remote)) return ['The remote target/root/generation changed since the proposal.']
    await host.workspaces.requireRemoteFiles().remote.request(workspace.remote!, 'roots.validate', {})
  }
  for (const print of prints) {
    if (print.kind === 'file') {
      const now = await fileSha(host.workspaces, workspace, print.id as string)
      if (now !== print.sha256) out.push(`${String(print.id)} changed since the proposal (${((print.sha256 as string | null) || 'absent').slice(0, 12)} -> ${(now || 'absent').slice(0, 12)})`)
    } else if (print.kind === 'workspace_tree' && tool === 'bash') {
      // a file write carries its own file precondition; a command was proposed against the whole tree
      const now = (await host.workspaces.git.snapshotTree(workspace.path, workspace.base_commit)).tree_sha
      if (now !== print.tree_sha) out.push(`the workspace moved since the proposal (tree ${(print.tree_sha as string).slice(0, 12)} -> ${now.slice(0, 12)})`)
    }
  }
  return out
}

/** Execute the approved call through the normal write path — the gate grants no shortcut past any guard. */
async function execute(host: GateHost, payload: Record<string, unknown>, onStarted: ((execution: { id: string }) => void) | null = null): Promise<Record<string, unknown>> {
  const tool = payload.tool_name as string
  let args: Record<string, unknown>
  try {
    args = validateArgs(tool, payload.validated_args as Record<string, unknown>) // validate AGAIN
  } catch (error) {
    throw new Error(`proposal no longer validates: ${(error as Error).message}`)
  }
  const workspace = repo.getWorkspace(host.conn, payload.workspace_id as string)!
  const session = repo.getSession(host.conn, payload.session_id as string)!
  const project = repo.getProject(host.conn, workspace.project_id)!
  const run = payload.run_id ? repo.getRun(host.conn, payload.run_id as string) : null
  if (run !== null && run.work_order !== null && orderOfRun(run) === null) throw new Error(`the work order of run ${run.id} no longer parses; nothing runs outside it`)
  const order = orderOfRun(run)
  const protectedPaths = [...host.config.protected_paths, ...((project.config.protected_paths as string[] | undefined) ?? []), ...(order?.protected_paths ?? [])]
  const locks = effectiveLocks(host.conn, session.id, project, order)
  const executor = hooks.executors[tool]
  if (executor === undefined) throw new Error(`no executor for tool '${tool}'`)
  const processes = (host as { processes?: { ensureTemp(workspaceId: string): string } }).processes
  return executor(host, args, {
    workspace, session, project, protected: protectedPaths, locks, run_id: (payload.run_id as string | null) ?? null,
    tool_call_id: (payload.tool_call_id as string | null) ?? null, order, pinned: pinnedOf(payload), temp: workspace.target?.kind === 'ssh' ? null : processes ? processes.ensureTemp(workspace.id) : null,
    context: { ...(payload.context && typeof payload.context === 'object' ? payload.context as Record<string, unknown> : {}),
      ...(workspace.target?.kind === 'ssh' ? { remote_expected_sha256: ((payload.base_fingerprints as Record<string, unknown>[]) ?? []).find(p => p.kind === 'file')?.sha256 ?? null } : {}) },
    on_started: onStarted ?? null,
  })
}

/** The statuses an executor answers when it did nothing: refused where it would have run (the grant, the order, a
 *  path), or the page no longer as it was looked at, in someone else's hands, or not ready for it. */
export const NOT_DONE = new Set(['refused', 'refused_by_policy', 'refused_by_work_order', 'stale', 'busy', 'person_active', 'covered', 'cancelled', 'unstable', 'not_actionable'])

/** A decision refused for a reason of the proposal's own (being decided, decided, drifted, a surface that cannot
 *  approve it): its code beside the words. A busy folder is WorkspaceBusy (workspace/locks.ts). */
export class ProposalConflict extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'ProposalConflict' }
}

export async function decideProposal(host: GateHost, proposalAssetId: string, decision: string, reason = '', actor = 'user'): Promise<Record<string, unknown>> {
  if (actor !== 'user') throw new Error('only the person decides action proposals — an agent cannot approve (or reject) its own gated actions')
  if (decision !== 'approve' && decision !== 'reject') throw new Error('decision must be approve or reject')
  const payload = loadProposal(host.conn, host.store, proposalAssetId)
  // taken synchronously, before any await: two decisions arriving together (a double click, a retried request) cannot
  // both pass the check below and both execute
  if (deciding.has(proposalAssetId)) throw new ProposalConflict(`proposal ${proposalAssetId} is being decided`, 'proposal_being_decided')
  const earlier = decisionFor(host.conn, proposalAssetId)
  if (earlier !== null) throw new ProposalConflict(`proposal ${proposalAssetId} is already decided (${statusOf(proposalAssetId, earlier)})`, 'proposal_already_decided')
  deciding.add(proposalAssetId)
  try {
    return await decide(host, proposalAssetId, payload, decision, reason)
  } finally {
    deciding.delete(proposalAssetId)
  }
}

async function decide(host: GateHost, proposalAssetId: string, payload: Record<string, unknown>, decision: string, reason: string): Promise<Record<string, unknown>> {
  const sessionId = payload.session_id as string
  const runId = (payload.run_id as string | null) ?? null
  if (decision === 'reject') {
    repo.logGovernance(host.conn, sessionId, DECISION, { actor: 'user', ref: proposalAssetId, run_id: runId, params: { decision: 'reject', reason } })
    return { status: 'rejected', proposal_asset_id: proposalAssetId }
  }
  // a command proposed with Full access is approved by the person or a caller that can grant it: never through a
  // director tool surface v1–v5 (or a connector client of none), which describes commands as sandboxed — refused, not
  // run in the sandbox instead of what was proposed
  if (pinnedOf(payload)?.access_mode === 'full' && currentRequestCap() === 'sandbox') {
    throw new ProposalConflict('this command was proposed with Full access; director tool surfaces v1–v5 keep commands sandboxed and cannot approve it. Approve it in oasis-code, or from a director on surface director.v6.', 'approval_surface_sandboxed')
  }
  // the folder is taken first, in the same step as the check (refused, naming its writer, while another holds it —
  // nothing is approved for later): what the drift check reads below is what the action then runs on
  const wsId = payload.workspace_id as string
  const owner = `approval:${proposalAssetId}`
  // a page action (computer_act) writes nothing of the folder — it reads a file it uploads, and what it downloads goes
  // to the temporary folder — so it is no writer of the folder and never waits for one (nor holds it)
  const writer = String(payload.tool_name) !== 'computer_act'
  if (writer && !host.locks.tryAcquire(wsId, owner, { kind: 'approval', proposal_id: proposalAssetId, run_id: runId, session_id: sessionId })) {
    throw host.locks.busy(wsId, 'approve', (h) => `approve ${holderEnds(h)}; nothing was approved`)
      ?? new WorkspaceBusy('the workspace has writers waiting for it; approve when they have run', {
        workspace_id: wsId, operation: 'approve', blocking_owner: 'unknown', blocking_kind: 'run', blocking_run_id: null, blocking_session_id: null, blocking_execution_ids: [],
        blocking_proposal_id: null, blocking_since: '', queued: 0, next_step: 'approve when the writers waiting for the folder have run',
      })
  }
  // the lease of an approved command still running when its wait ended: the folder stays held until it really ended
  let leased = false
  let result: Record<string, unknown>
  try {
    const drifted = await drift(host, payload)
    if (drifted.length) {
      throw new ProposalConflict(`proposal base drifted since it was made — ${drifted.join('; ')}. Reject it and let the agent re-propose against the current state.`, 'proposal_drifted')
    }
    // the intent is on record before the action runs: if the process ends inside it, the proposal reads interrupted
    // and is not executed again (at most once; what happened is the workspace's to show)
    repo.logGovernance(host.conn, sessionId, DECISION, { actor: 'user', ref: proposalAssetId, run_id: runId, params: { decision: 'approve', reason, outcome: 'executing' } })
    try {
      // a command that started is on record as running, with its execution id, while it runs (and named to whoever
      // waits for the folder)
      result = await execute(host, payload, (execution) => {
        if (writer) host.locks.annotate(wsId, owner, { execution_id: execution.id })
        repo.logGovernance(host.conn, sessionId, DECISION, {
          actor: 'user', ref: proposalAssetId, run_id: runId, params: { decision: 'approve', reason, outcome: 'executing', execution_id: execution.id },
        })
      })
    } catch (error) {
      repo.logGovernance(host.conn, sessionId, DECISION, {
        actor: 'user', ref: proposalAssetId, run_id: runId, params: { decision: 'approve', reason, outcome: 'failed', result_status: 'error', result_summary: String((error as Error)?.message ?? error).slice(0, 600) },
      })
      throw error
    }
    const xid = typeof result.execution_id === 'string' ? result.execution_id : null
    const processes = (host as { processes?: { wait(xid: string, timeoutS: number | null): Promise<unknown> } }).processes
    if (writer && result.status === 'running' && xid !== null && processes) leased = host.locks.holdUntil(wsId, owner, xid, processes.wait(xid, null))
  } finally {
    if (writer) host.locks.release(wsId, owner)
  }
  if (leased) result = { ...result, holds_workspace_until_exit: true }
  const summary = JSON.stringify(result).slice(0, 600)
  // an error is no completion: it may have stopped part way (said as failed, never as done or as nothing done)
  const outcome = NOT_DONE.has(String(result.status)) ? 'refused' : result.status === 'unknown' ? 'unknown' : result.status === 'error' ? 'failed' : 'done'
  repo.logGovernance(host.conn, sessionId, DECISION, {
    actor: 'user', ref: proposalAssetId, run_id: runId, params: { decision: 'approve', reason, outcome, result_status: result.status ?? null, result_summary: summary },
  })
  const workspace = repo.getWorkspace(host.conn, payload.workspace_id as string)!
  require('../agent/human_runs.ts')            // registers the recorder when nothing else imported it yet
  hooks.recordHumanRun(host.conn, {
    session_id: sessionId, project_id: workspace.project_id, workspace_id: workspace.id, label: `approved ${String(payload.tool_name)}`,
    text: `approved proposal ${proposalAssetId}: ${String(result.status)}`,
    produced: { workspace_id: workspace.id, base_commit: workspace.base_commit, executions: result.execution_id ? [result.execution_id] : [] },
    kind: 'approve_proposal',
  })
  return { status: 'approved', proposal_asset_id: proposalAssetId, result }
}

/** The continuation bridge: the session's recent proposals and decisions, put into the next run's first message so
 *  a fresh process picks up exactly where the gate stopped the last one. */
export function proposalPromptNote(conn: Conn, projectId: string, sessionId: string, limit = 5): string {
  const proposals = listProposals(conn, projectId, sessionId)
  if (!proposals.length) return ''
  return proposals.slice(-limit).map(proposalLine).join('\n')
}

/** One proposal's state as the next run reads it: one state, one meaning — waiting, running, completed with its
 *  result, failed, interrupted with an unknown effect, or rejected. */
export function proposalLine(p: ProposalRow): string {
  const id = p.proposal_asset_id
  const decision = p.decision ?? {}
  const result = String(decision.result_summary ?? decision.result_status ?? 'no result recorded').slice(0, 300)
  // the person's own words on the decision, when they gave any, follow the state
  const reason = typeof decision.reason === 'string' && decision.reason.trim() ? ` Reason: ${decision.reason.trim().slice(0, 300)}` : ''
  switch (p.status) {
    case 'pending': return text('approval.pending', { id })
    case 'executing': return text('approval.running', { id, execution_id: String(decision.execution_id ?? 'unknown') })
    case 'interrupted': return text('approval.unknown', { id })
    case 'reject': return text('approval.rejected', { id }) + reason
    case 'approve': return (decision.outcome === 'failed' ? text('approval.failed', { id, result }) : decision.outcome === 'refused' ? text('approval.not_done', { id, result })
      : decision.outcome === 'unknown' ? text('approval.outcome_unknown', { id, result }) : text('approval.done', { id, result })) + reason
    default: return `Proposal ${id}: ${p.status}.`
  }
}
