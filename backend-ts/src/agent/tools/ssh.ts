/** The SSH tools: an agent connects a host on the person's yes, looks at its folders, opens a session there and
 *  forwards a port of a session on a host. The question is the harness's (marked `harness`, as the Full access one:
 *  no agent's form passes for it), asked in the conversation where the call was made; nothing is saved, trusted or
 *  dialed before the yes. */

import { z, type SshTarget } from '@oasis-code/contract'
import * as repo from '../../db/repo.ts'
import * as targets from '../../db/remote_repo.ts'
import { HarnessError } from '../../director/harness.ts'
import { PROMPT_TEXT } from '../../prompt_texts.ts'
import { RemoteError } from '../../remote/types.ts'
import { RemoteRefused } from '../../workspace/remote.ts'
import { askText, SshConnectRefused, type SshConnectPlan } from '../../workspace/ssh_hosts.ts'
import { awaitAnswer } from '../ui_inputs.ts'
import { refreshSession } from '../deps.ts'
import { delegationBound, DelegationRefused } from '../../policy/delegation.ts'
import { networkGranted } from '../../policy/permissions.ts'
import { finish, orderRefused, refused, type Ctx, type Payload } from './common.ts'
import { register } from './registry.ts'

const P = (tool: string, key: string) => PROMPT_TEXT[`parameter.${tool}.${key}` as keyof typeof PROMPT_TEXT]

/** The harness's question before an SSH host is saved or connected. */
export const SSH_CONNECT_ASK = 'ssh_connect'

export function sshConnectRequest(plan: SshConnectPlan): Record<string, unknown> {
  const { title, lines } = askText(plan)
  return {
    harness: SSH_CONNECT_ASK, title, message: lines.join('\n'), root: 'connect',
    elements: { connect: { type: 'select', props: { label: 'Connect', key: 'connect', options: [{ label: 'Connect', value: 'yes' }] } } },
    initial_state: { connect: 'yes' }, required: ['connect'],
  }
}

function hostView(t: SshTarget): Payload {
  return { target_id: t.id, name: t.label, destination: t.destination, port: t.port ?? null, state: t.state, ...(t.last_error ? { error: t.last_error } : {}) }
}

/** A refusal the model can act on (a host it cannot reach, a folder that is not there), never a crash of the run. */
function reason(error: unknown): string | null {
  if (error instanceof SshConnectRefused || error instanceof RemoteRefused || error instanceof RemoteError || error instanceof HarnessError) return error.message
  return null
}

/** A tool that reaches an SSH host (a connection, a folder listing, a forward) reaches the network: refused when the
 *  run's work order or the session's grant has the network off — the same bounds a web tool is held to. */
function networkRefused(ctx: Ctx, tool: string): Payload | null {
  const byOrder = orderRefused(ctx, tool, { network: true })
  if (byOrder !== null) return byOrder
  if (!networkGranted(refreshSession(ctx.deps).grants)) {
    ctx.deps.blocked_calls += 1
    return refused(ctx, tool, 'The session\'s network grant is off: an SSH host is not reached from this run.')
  }
  return null
}

const ConnectArgs = z.object({
  destination: z.string().min(1).nullable().optional().describe(P('ssh_connect', 'destination')),
  port: z.number().int().min(1).max(65535).nullable().optional().describe(P('ssh_connect', 'port')),
  identity_file: z.string().min(1).nullable().optional().describe(P('ssh_connect', 'identity_file')),
  name: z.string().min(1).max(200).nullable().optional().describe(P('ssh_connect', 'name')),
  target_id: z.string().min(1).nullable().optional().describe(P('ssh_connect', 'target_id')),
})

async function sshConnect(ctx: Ctx, args: z.infer<typeof ConnectArgs>): Promise<Payload> {
  const deps = ctx.deps
  if (deps.ssh === null) return refused(ctx, 'ssh_connect', 'SSH is not available in this run')
  const offline = networkRefused(ctx, 'ssh_connect')
  if (offline !== null) return offline
  let plan: SshConnectPlan
  try { plan = await deps.ssh.hosts.plan(args) } catch (error) {
    const why = reason(error)
    if (why === null) throw error
    return refused(ctx, 'ssh_connect', why)
  }
  if (plan.ready) return finish(ctx, 'ssh_connect', { status: 'connected', host: hostView(deps.ssh.remote.target(plan.target_id!)) }, { summary: `${plan.label}: connected` })
  // written, waited on and announced in one synchronous stretch (as request_input)
  const pending = repo.insertUiInput(deps.conn, { session_id: deps.session.id, run_id: deps.run_id, tool_call_id: ctx.tool_call_id, request: sshConnectRequest(plan) })
  const answered = awaitAnswer(deps.conn, pending.id, deps.cancel_signal, deps.stop_reason)
  deps.emit('ui_input', { input: pending })
  const record = await answered
  deps.emit('ui_input', { input: record })
  if (record.status === 'closed') return finish(ctx, 'ssh_connect', { status: 'closed', reason: record.closed_reason ?? 'cancelled' }, { summary: `${plan.label}: not answered` })
  if (record.status !== 'submitted' || record.values?.connect !== 'yes') return finish(ctx, 'ssh_connect', { status: 'declined' }, { summary: `${plan.label}: declined` })
  try {
    const target = await deps.ssh.hosts.apply(plan)
    const up = target.state === 'ready'
    return finish(ctx, 'ssh_connect', { status: up ? 'connected' : 'failed', host: hostView(target) }, { summary: `${plan.label}: ${up ? 'connected' : target.state}` })
  } catch (error) {
    const why = reason(error)
    if (why === null) throw error
    const saved = plan.target_id ?? targets.listTargets(deps.conn).find((t) => t.destination === plan.destination && (t.port ?? null) === plan.port && (t.identity_file ?? null) === plan.identity_file)?.id ?? null
    return finish(ctx, 'ssh_connect', { status: 'failed', error: why, ...(saved ? { host: hostView(deps.ssh.remote.target(saved)) } : {}) }, { summary: `${plan.label}: failed` })
  }
}

async function sshHosts(ctx: Ctx): Promise<Payload> {
  const hosts = targets.listTargets(ctx.deps.conn).map(hostView)
  return finish(ctx, 'ssh_hosts', { hosts }, { summary: `${hosts.length} host${hosts.length === 1 ? '' : 's'}` })
}

const DirsArgs = z.object({
  target_id: z.string().min(1).describe(P('ssh_directories', 'target_id')),
  path: z.string().default('/').describe(P('ssh_directories', 'path')),
})

async function sshDirectories(ctx: Ctx, args: z.infer<typeof DirsArgs>): Promise<Payload> {
  const ssh = ctx.deps.ssh
  if (ssh === null) return refused(ctx, 'ssh_directories', 'SSH is not available in this run')
  const offline = networkRefused(ctx, 'ssh_directories')
  if (offline !== null) return offline
  // an order's read scope bounds what the run reads; a folder on another host is outside every path it names
  if (ctx.deps.work_order !== null && ctx.deps.work_order.scope.read !== null) {
    ctx.deps.blocked_calls += 1
    return finish(ctx, 'ssh_directories', { status: 'refused_by_work_order', tool: 'ssh_directories', reason: 'This run reads only the paths its work order names; folders on an SSH host are outside them.' }, { summary: 'refused: outside the readable paths' })
  }
  try {
    const page = await ssh.remote.listDirs(args.target_id, args.path)
    return finish(ctx, 'ssh_directories', { path: page.path, parent: page.parent, directories: page.entries.map((e) => e.name), truncated: page.truncated }, { summary: page.path })
  } catch (error) {
    const why = reason(error)
    if (why === null) throw error
    return refused(ctx, 'ssh_directories', why)
  }
}

const OpenArgs = z.object({
  target_id: z.string().min(1).describe(P('open_ssh_session', 'target_id')),
  path: z.string().min(1).describe(P('open_ssh_session', 'path')),
  message: z.string().min(1).describe(P('open_ssh_session', 'message')),
  remote_state_path: z.string().min(1).nullable().optional().describe(P('open_ssh_session', 'remote_state_path')),
  model: z.string().min(1).nullable().optional().describe(P('open_ssh_session', 'model')),
})

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' ? v as Rec : {})

async function openSshSession(ctx: Ctx, args: z.infer<typeof OpenArgs>): Promise<Payload> {
  const deps = ctx.deps
  const ssh = deps.ssh
  if (ssh === null) return refused(ctx, 'open_ssh_session', 'SSH is not available in this run')
  // what this run starts on the host is no wider than this run: its access, its mode as the run sees it (a gate scoped
  // to it included), its grants; a run under a work order or in the sandbox is refused (policy/delegation.ts). The API
  // holds the requests to the same bounds, knowing them for this run's (the header), never the person's.
  let bound
  try {
    bound = delegationBound(deps.conn, { run_id: deps.run_id, session_id: refreshSession(deps).id, parent_run_id: (deps as { parent_run_id?: string | null }).parent_run_id ?? null, work_order: deps.work_order })
  } catch (error) {
    if (!(error instanceof DelegationRefused)) throw error
    deps.blocked_calls += 1
    return refused(ctx, 'open_ssh_session', error.message, { code: error.code })
  }
  const offline = networkRefused(ctx, 'open_ssh_session')
  if (offline !== null) return offline
  const harness = ssh.api()
  if (harness === null) return refused(ctx, 'open_ssh_session', 'The app is not serving yet')
  const api = harness.with({ agent_run_id: deps.run_id })
  if (!args.path.startsWith('/')) return refused(ctx, 'open_ssh_session', 'path must be absolute')
  let target: SshTarget
  try { target = ssh.remote.target(args.target_id) } catch (error) { return refused(ctx, 'open_ssh_session', reason(error) ?? String(error)) }
  if (!ssh.remote.isReady(target.id)) return refused(ctx, 'open_ssh_session', `${target.label} is not connected (${target.state}); ssh_connect connects it`)
  try {
    // the same remote folder with the same state directory is one project
    const projects = (await api.get('/api/projects')) as unknown[]
    const found = projects.map(rec).find((p) => rec(p.target).kind === 'ssh' && rec(p.target).target_id === target.id && p.kind === 'direct'
      && (p.source_path === args.path || rec(p.import_report).requested_path === args.path) && (rec(p.import_report).requested_state_path ?? null) === (args.remote_state_path ?? null))
    const project = found ?? rec(await api.post('/api/projects', { source_path: args.path, target: { kind: 'ssh', target_id: target.id }, mode: 'direct', ...(args.remote_state_path ? { remote_state_path: args.remote_state_path } : {}) }))
    const session = rec(await api.post(`/api/projects/${encodeURIComponent(String(project.id))}/sessions`, { model: args.model ?? deps.model_cfg.id, mode: bound.mode }))
    const run = rec(await api.post(`/api/sessions/${encodeURIComponent(String(session.id))}/chat`, { text: args.message }))
    return finish(ctx, 'open_ssh_session', { status: 'started', session_id: session.id, project_id: project.id, run_id: run.id, host: target.label, path: project.source_path ?? args.path, mode: bound.mode },
      { summary: `${target.label}: ${String(project.source_path ?? args.path)}`, session_id: session.id })
  } catch (error) {
    const why = reason(error)
    if (why === null) throw error
    return refused(ctx, 'open_ssh_session', why)
  }
}

const ForwardArgs = z.object({ remote_port: z.number().int().min(1).max(65535).describe(P('forward_port', 'remote_port')) })

async function forwardPort(ctx: Ctx, args: z.infer<typeof ForwardArgs>): Promise<Payload> {
  const { ssh, workspace } = ctx.deps
  if (ssh === null) return refused(ctx, 'forward_port', 'SSH is not available in this run')
  if (workspace.target?.kind !== 'ssh' || !workspace.remote) return refused(ctx, 'forward_port', 'This session works on this computer, not on an SSH host')
  const offline = networkRefused(ctx, 'forward_port')
  if (offline !== null) return offline
  try {
    await ssh.remote.request(workspace.remote, 'roots.validate', {})
    const forward = await ssh.remote.openForward(workspace.target.target_id, workspace.id, args.remote_port)
    return finish(ctx, 'forward_port', { status: forward.state, local_url: forward.local_url, remote_port: forward.remote_port }, { summary: `${forward.remote_port} → ${forward.local_url}` })
  } catch (error) {
    const why = reason(error)
    if (why === null) throw error
    return refused(ctx, 'forward_port', why)
  }
}

register({
  name: 'ssh_connect', effect: 'state_change', action: null, renderer: 'generic', summary: 'connect an SSH host on the person\'s yes',
  description: PROMPT_TEXT['tool.ssh_connect'], schema: ConnectArgs, fn: sshConnect,
})
register({
  name: 'ssh_hosts', effect: 'read', action: null, renderer: 'generic', summary: 'list the saved SSH hosts',
  description: PROMPT_TEXT['tool.ssh_hosts'], schema: z.object({}), fn: (ctx) => sshHosts(ctx),
})
register({
  name: 'ssh_directories', effect: 'read', action: null, renderer: 'generic', summary: 'list folders on an SSH host',
  description: PROMPT_TEXT['tool.ssh_directories'], schema: DirsArgs, fn: sshDirectories,
})
register({
  name: 'open_ssh_session', effect: 'state_change', action: null, renderer: 'generic', summary: 'start a session in a folder on an SSH host',
  description: PROMPT_TEXT['tool.open_ssh_session'], schema: OpenArgs, fn: openSshSession,
})
register({
  name: 'forward_port', effect: 'state_change', action: null, renderer: 'generic', summary: 'forward a port of the SSH host',
  description: PROMPT_TEXT['tool.forward_port'], schema: ForwardArgs, fn: forwardPort,
})
