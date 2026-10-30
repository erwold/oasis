/** Shared application state, and the factory that assembles it (what the server, the tests and the scripts share). */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, Session } from '@oasis-code/contract'
import { exportEnvironment } from '../auth/keys.ts'
import { setDefaultAuthDir } from '../auth/store.ts'
import { getSettings, type HarnessConfig, type Settings } from '../config.ts'
import { connect, type Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { claimDataDir } from '../db/instance.ts'
import { buildRuntime, unavailable, type IsolationReport, type IsolationRuntime } from '../execution/isolation.ts'
import { ProcessManager } from '../execution/processes.ts'
import { ChatGptBridge, type ChatGptBridgeOptions } from '../llm/chatgpt_web.ts'
import { desktopComputer, type ComputerClient } from '../computer/desktop.ts'
import type { Model } from '../llm/model.ts'
import { SlotRegistry } from '../llm/slots.ts'
import { ActionGate } from '../policy/permissions.ts'
import { AssetStore } from '../store.ts'
import { lockKeyOf, WorkspaceLocks } from '../workspace/locks.ts'
import { WorkspaceService } from '../workspace/service.ts'
import { RemoteWorkspaceService, type ReconnectPolicy, type RemoteProviderFactory } from '../workspace/remote.ts'
import { createSshRemoteProvider } from '../workspace/ssh_provider.ts'
import type { TransportOptions } from '../remote/types.ts'
import { SshHostsService, systemHostKeys, type HostKeys } from '../workspace/ssh_hosts.ts'
import { RemoteFiles } from '../workspace/remote_files.ts'
import { RemoteExecutionDriver } from '../execution/remote_driver.ts'
import type { RunManager } from '../agent/runner.ts'
import type { RelayManager } from '../agent/relay.ts'
import type { InteractionManager } from '../agent/interactions.ts'
import type { DirectorService, DirectorServiceOptions } from '../director/controller.ts'
import type { WatchService, WatchServiceOptions } from '../agent/watches/service.ts'
import type { UiTaskService } from '../agent/ui_tasks.ts'
import type { LiveShareService } from '../share/live/service.ts'

export interface AppState {
  settings: Settings
  config: HarnessConfig
  conn: Conn
  store: AssetStore
  workspaces: WorkspaceService
  remote: RemoteWorkspaceService
  remote_driver: RemoteExecutionDriver
  // saving and connecting SSH hosts on the person's yes (an agent's or a connector's question)
  ssh: SshHostsService
  processes: ProcessManager
  gate: ActionGate
  locks: WorkspaceLocks
  isolation: IsolationReport
  /** gives up this process's claim on the data directory (closeState) */
  release_data: () => void
  slots: SlotRegistry
  // model id -> a prebuilt model (tests script models; production builds from config)
  model_overrides: Map<string, Model>
  runs: RunManager
  // the relay: one message to several agents who take turns on it, scheduled and persisted by the harness
  relays: RelayManager
  // the interaction: one message to several agents run as a graph of nodes (the director's plan, or a template's)
  interactions: InteractionManager
  // the director session: the harness holding the conversation with an outside director and continuing it
  director: DirectorService
  // the desktop app's ChatGPT page, as the runs on ChatGPT on the web reach it
  chatgpt: ChatGptBridge
  // the desktop app's computer (the pages an agent looks at and acts on), reached through its bridge server
  computer: ComputerClient
  // the watches: what an agent of a session's own conversation asked to be woken for, checked without a model
  watches: WatchService
  // Intelligent UI's tasks: a surface's `run` actions, queued behind the conversation and started as it frees
  ui_tasks: UiTaskService
  session_token: string
  /** live read-only session sharing (share/live/service.ts): made by createApp; its listener binds only on start() and
   *  only when the person turned it on */
  live_share?: LiveShareService
  /** how often a run's event stream sends a keep-alive comment */
  sse_heartbeat_ms: number
}

export class HttpError extends Error {
  /** code: a machine-readable reason beside the detail, where a route names one (a steer's refusal) */
  constructor(readonly status: number, message: string, readonly code: string | null = null, readonly extra: Record<string, unknown> | null = null) { super(message); this.name = 'HttpError' }
}

export function requireProject(state: AppState, projectId: string): Project {
  const project = repo.getProject(state.conn, projectId)
  if (project === null) throw new HttpError(404, `project not found: ${projectId}`)
  return project
}

export function requireSession(state: AppState, sessionId: string): Session {
  const session = repo.getSession(state.conn, sessionId)
  if (session === null || session.status === repo.DELETED_SESSION) throw new HttpError(404, `session not found: ${sessionId}`)
  return session
}

export interface BuildOptions {
  model_overrides?: Map<string, Model> | Record<string, Model>
  isolation?: IsolationReport | null
  /** probe the isolation runtime (the default); false reports unavailable, so bash refuses */
  probe?: boolean
  runtime?: IsolationRuntime
  sse_heartbeat_ms?: number
  director?: DirectorServiceOptions
  /** where the ChatGPT page's bridge is and how it is asked (a test plays the bridge) */
  chatgpt?: ChatGptBridgeOptions
  /** the desktop app's computer (a test plays it) */
  computer?: ComputerClient
  watches?: WatchServiceOptions
  remote_provider?: RemoteProviderFactory
  /** Constructor-only SSH fixture options; never populated from REST or project configuration. */
  remote_transport?: TransportOptions
  /** Constructor-only: the reconnection schedule and the waits of the SSH connection (a test's are short). */
  remote_reconnect?: Partial<ReconnectPolicy>
  /** How host keys are looked up and trusted (a test's host has none to read) */
  ssh_host_keys?: HostKeys
}

/** A quiet event stream says it is alive this often: well inside the server's idle timeout (255 s) and a tunnel's. */
export const SSE_HEARTBEAT_MS = 15_000

/** The services behind the app, assembled once: the OAuth grants and the saved keys live beside the database;
 *  custom keys reach this process's environment; the isolation runtime is probed and its report is what the
 *  product shows. */
export async function buildState(settingsIn?: Settings | null, configIn?: HarnessConfig | null, opts: BuildOptions = {}): Promise<AppState> {
  const settings = settingsIn ?? getSettings()
  mkdirSync(settings.data_dir, { recursive: true })
  // before anything of the data is read or recovered: one harness per data directory
  const releaseData = claimDataDir(settings.data_dir)
  const config = configIn ?? settings.load()
  setDefaultAuthDir(settings.data_dir)
  exportEnvironment()
  const conn = connect(settings.db_path)
  const runtime = opts.runtime ?? buildRuntime({ extra_read_deny: [settings.data_dir] })
  const report = opts.isolation ?? ((opts.probe ?? true) ? await runtime.probe(settings.data_dir) : unavailable(runtime.name, 'not probed'))
  const store = new AssetStore(settings.assets_dir)
  const overrides = opts.model_overrides instanceof Map ? opts.model_overrides : new Map(Object.entries(opts.model_overrides ?? {}))
  // the host keys the person trusted in the app, read after their own known_hosts
  const transport: TransportOptions = { app_known_hosts_file: join(settings.data_dir, 'ssh', 'known_hosts'), ...opts.remote_transport }
  const { RunManager } = await import('../agent/runner.ts')
  const { RelayManager } = await import('../agent/relay.ts')
  const { InteractionManager } = await import('../agent/interactions.ts')
  const { DirectorService } = await import('../director/controller.ts')
  const { WatchService } = await import('../agent/watches/service.ts')
  const { UiTaskService } = await import('../agent/ui_tasks.ts')
  const state = {
    settings, config, conn, store, workspaces: new WorkspaceService(settings, conn), processes: new ProcessManager(settings, conn, store, runtime, report),
    remote: new RemoteWorkspaceService(conn, opts.remote_provider ?? createSshRemoteProvider(transport), opts.remote_reconnect ?? {}),
    gate: new ActionGate(conn), locks: new WorkspaceLocks(join(settings.data_dir, 'locks'), (id) => lockKeyOf(repo.getWorkspace(conn, id), id)), isolation: report, slots: new SlotRegistry(),
    model_overrides: overrides, session_token: '', sse_heartbeat_ms: opts.sse_heartbeat_ms ?? SSE_HEARTBEAT_MS, release_data: releaseData,
    chatgpt: new ChatGptBridge(settings.data_dir, opts.chatgpt ?? {}),
    computer: opts.computer ?? desktopComputer(settings.data_dir),
  } as AppState
  state.workspaces.remoteFiles = new RemoteFiles(state.remote)
  state.remote_driver = new RemoteExecutionDriver({ conn, remote: state.remote, callbacks: {
    onOutput: event => state.processes.emitRemoteOutput(event),
    onEnd: id => {
      state.processes.emitRemoteEnd(id)
      queueMicrotask(() => { if (!state.processes.preserveRemoteOnShutdown) void (async () => {
        const execution = repo.getExecution(conn, id)
        const ws = execution?.workspace_id ? repo.getWorkspace(conn, execution.workspace_id) : null
        if (ws?.target?.kind === 'ssh') await state.workspaces.requireRemoteFiles().recoverTarget(ws.target.target_id)
      })().catch(() => {}) })
    },
    onConnection: (id, connected) => state.processes.emitRemoteConnection(id, connected),
  } })
  state.remote_driver.rehydrate()
  state.ssh = new SshHostsService({ conn, remote: state.remote, afterConnect: async (targetId) => {
    await state.workspaces.requireRemoteFiles().recoverTarget(targetId)
    state.remote_driver.startPolling()
  } }, opts.ssh_host_keys ?? systemHostKeys(transport))
  state.processes.remoteDriver = state.remote_driver
  // A connection that came back by itself (after a restart or a lost network): the jobs and watches on the target
  // are polled at once, and its journal receipts and leases reconciled — as the person's Connect does in its route.
  state.remote.onReady((targetId, how) => {
    if (how !== 'reconnect') return
    state.remote_driver.startPolling()
    void state.remote_driver.poll().catch(() => {})
    void state.workspaces.requireRemoteFiles().recoverTarget(targetId).catch(() => {})
  })
  state.runs = new RunManager(state)
  // the relay's hook comes first: the next turn's row exists before the director hears the earlier one ended
  state.relays = new RelayManager(state)
  state.relays.attachHooks()
  state.director = new DirectorService(state, opts.director ?? {})
  state.director.attachHooks()
  // the interaction's hooks after the director's: it hears a run's end after the outbox (which leaves its runs
  // alone) and a director turn's end from the director itself
  state.interactions = new InteractionManager(state)
  state.interactions.attachHooks()
  // the UI tasks' hook after the relay's and the interaction's (their next step's run comes first) and before the
  // watches' (a person's press goes before a wake)
  state.ui_tasks = new UiTaskService(state)
  state.ui_tasks.attachHooks()
  // the watches' hook last: a conversation that becomes free takes its waiting events once the others have heard
  state.watches = new WatchService(state, opts.watches ?? {})
  state.watches.attachHooks()
  return state
}

export async function closeState(state: AppState): Promise<void> {
  // the share listener and its viewers first: nothing is projected from a state being taken down
  await state.live_share?.close()
  state.processes.preserveRemoteOnShutdown = true
  state.watches.close()
  state.ui_tasks.close()
  state.relays.shutdown()
  state.interactions.shutdown()
  await state.director.shutdown()
  await state.runs.shutdown()
  await state.processes.shutdown()
  await state.runs.closeModels()
  state.workspaces.close()
  await state.remote?.close()
  state.conn.close()
  state.release_data()
}
