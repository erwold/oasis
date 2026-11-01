/** Processes: every repository command runs through here — in the isolation runtime (Sandbox) or on the host as the
 *  user (Full access, with only the restrictions chosen for it held by the OS) — in its own process group, with its
 *  output streamed to log files on disk (under a byte cap only when one applies: the sandbox's, or one configured for
 *  Full access; what a cap or a failed write did not keep is counted and said, never called kept), read back in
 *  bounded pages. A deadline applies only when one was given or configured (Full access sets none of its own). The
 *  execution row records the intent before the process starts and the outcome after; a process the harness loses (a restart) is `lost` with effect_state unknown,
 *  never replayed. A command's effects end with it: when its process is gone — it exited, a stop or a timeout
 *  killed its group — whatever it left running (a child that left the group, a grandchild handed to init) is found
 *  by the execution id every command carries in its environment and killed too. */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir, constants as osConstants } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Execution, OutputWindow, Workspace } from '@oasis-code/contract'
import { RemoteRefused } from '../workspace/remote.ts'
import type { LeaseProof } from '../remote/types.ts'
import type { Settings } from '../config.ts'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import type { AssetStore } from '../store.ts'
import { monotonic } from '../timebase.ts'
import { DEFAULT_LIMITS, HostRestrictionUnavailable, hostRestricted, IsolationUnavailable, limitedArgv, LIMITS_REFUSED_EXIT, LIMITS_REFUSED_LINE, resolveRealPath, scrubbedEnv, type HostRestrictions, type IsolationReport, type IsolationRuntime, type ResourceLimits, type Sandbox } from './isolation.ts'
import { XCRUN_TOOLS, XcrunWarmer, xcrunCacheMisses } from './xcrun.ts'
import { descendantsOf, environmentBuffer, environmentOf, ForkWatcher, identities, identityOf, isZombie, type ProcessIdentity } from './lineage.ts'
import { dropSnapshot, hostCommandEnv, loginShellArgv, loginShellOf, SNAPSHOT_TTL_MS, snapshotArgv, snapshotCommandEnv, takeLoginSnapshot, type LoginSnapshot } from './host_env.ts'
import type { AccessMode } from '@oasis-code/contract/modes'
import type { AccessReason } from '../policy/access.ts'

const signals: Record<string, number> = osConstants.signals as unknown as Record<string, number>

/** Claude Code's Bash output limits (https://code.claude.com/docs/en/tools-reference#output-limits, read 2026-10-15),
 *  in characters: a result up to INLINE_CHARS is shown whole; a longer one that succeeded shows its first PREVIEW_CHARS
 *  and where the whole output is; a longer one that failed shows FAILURE_EXCERPT_CHARS of its first INLINE_CHARS, the
 *  head and the tail. An exit of 1 from these commands is no failure (their way of saying "nothing found", "differs"). */
export const INLINE_CHARS = 30_000
export const PREVIEW_CHARS = 2_000
export const FAILURE_EXCERPT_CHARS = 10_000
const BENIGN_EXIT_1 = ['grep', 'rg', 'egrep', 'fgrep', 'find', 'diff', 'test', '[', 'git diff', 'git grep']
/** The variable every command process (and so its descendants) carries: the execution it belongs to. */
export const EXECUTION_ID_VARIABLE = 'OASIS_CODE_EXECUTION_ID'
/** Rounds of finding and killing what a command left behind (a killed process is gone by the next round). */
const STRAY_ROUNDS = 6
/** The defaults of a sandboxed command when its caller names none (the sandbox's own; Full access has none). */
export const SANDBOX_DEFAULT_TIMEOUT_S = 600
export const SANDBOX_DEFAULT_OUTPUT_CAP_BYTES = 8 * 1024 * 1024
/** A finished log up to this size is sealed from memory; a larger one is streamed into the store (never read whole). */
const SEAL_IN_MEMORY_BYTES = 1024 * 1024
/** How often the running commands' descendants are read into their lineages (one reading of the process table for
 *  all of them, the manager's lineage tick), and how often a command's own watch looks at its deadline and its stop:
 *  a process that starts a child and ends within this long is the one link the lineage can miss (its child's creator
 *  is then unknown). */
const LINEAGE_TICK_MS = 50

interface ProcessRow { pid: number; ppid: number; uid: number; env: string[] }

/** This user's processes with their parents and environments, each variable apart from the arguments (the kernel's
 *  block on macOS, /proc on Linux); another user's process is listed without its environment. */
function processTable(): ProcessRow[] {
  const rows: ProcessRow[] = []
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  const out = spawnSync('ps', [process.platform === 'darwin' ? '-ax' : '-e', '-o', 'pid=,ppid=,uid='], { encoding: 'utf8', timeout: 5000 }).stdout ?? ''
  const buffer = environmentBuffer() ?? undefined
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    let env: string[] = []
    if (uid < 0 || Number(m[3]) === uid) {
      if (process.platform === 'darwin') env = environmentOf(pid, buffer) ?? []
      else {
        try { env = readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').filter(Boolean) } catch { env = [] }
      }
    }
    rows.push({ pid, ppid: Number(m[2]), uid: Number(m[3]), env })
  }
  return rows
}

/** The processes an execution (or several) left behind: this user's processes carrying the execution id in their
 *  environment — a child that left the process group with setsid, a grandchild reparented to init once its parent
 *  exited — and the descendants of the given root processes by parent. The id is matched as a whole variable of the
 *  environment: a process whose arguments merely carry the text is not the command's. A process that cleared its
 *  own environment after leaving the group is not found: the sweep bounds what a command leaves, the confinement is
 *  the sandbox's. */
export function strayProcesses(xids: string[], roots: number[] = []): { pid: number; xid: string | null }[] {
  const table = processTable()
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  const marks = xids.map((x) => `${EXECUTION_ID_VARIABLE}=${x}`)
  const found = new Map<number, string | null>()
  for (const row of table) {
    if (row.pid === process.pid || (uid >= 0 && row.uid !== uid)) continue
    const mark = marks.find((m) => row.env.includes(m))
    if (mark !== undefined) found.set(row.pid, mark.slice(EXECUTION_ID_VARIABLE.length + 1))
  }
  const byParent = new Map<number, number[]>()
  for (const row of table) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row.pid])
  const queue = [...roots]
  while (queue.length) {
    const parent = queue.shift()!
    for (const child of byParent.get(parent) ?? []) {
      if (child === process.pid) continue
      if (!found.has(child)) found.set(child, null)
      queue.push(child)
    }
  }
  return [...found].map(([pid, xid]) => ({ pid, xid }))
}

/** Whether a process has exited and only waits for its parent to reap it (a zombie): the kernel's word on macOS,
 *  /proc on Linux. */
export function exitedAwaitingReap(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'latin1')
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')
    } catch { return false }
  }
  return isZombie(pid)
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

/** What tells a process from a later one given the same pid: its kernel unique id on macOS, its start time (in
 *  clock ticks since boot) on Linux; null when it is gone or cannot be read. */
export function processIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (process.platform === 'darwin') return identityOf(pid)?.uniqueid.toString() ?? null
  if (process.platform !== 'linux') return null
  let stat: string
  try { stat = readFileSync(`/proc/${pid}/stat`, 'latin1') } catch { return null }
  // the fields after the command name (which may hold spaces and parentheses): the state is field 3, the start time 22
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const start = fields[19]
  return start !== undefined && /^\d+$/.test(start) ? `start:${start}` : null
}

/** The command's own process as its execution records it: what a later life of the harness finds it by. */
export interface RecordedRoot { root_pid?: unknown; root_identity?: unknown; root_uniqueid?: unknown }

/** The command's process of an execution, while it is still that process (never another one given its pid). */
function liveRoot(recorded: RecordedRoot): number | null {
  const pid = Number(recorded.root_pid)
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null
  if (typeof recorded.root_identity !== 'string' || processIdentity(pid) !== recorded.root_identity) return null
  return pid
}

/** Where a command's deadline came from: the call, the configuration, a check's own, the sandbox's default. */
export type TimeoutSource = 'call' | 'config' | 'check' | 'default'

/** What a command was held to, as it ran: recorded with the execution and returned with its result. */
export interface CommandRestrictions {
  /** host: the user's login shell, HOME, TMPDIR and environment; sandbox: a HOME and TMPDIR of the workspace's, an
   *  environment built from the configured names */
  environment: 'host' | 'sandbox'
  /** what enforces the OS rules: 'none', or the isolation runtime's name */
  enforced_by: string
  network: 'allowed' | 'denied'
  /** none: the user's own files; sandbox: the sandbox's rules; restricted: the user's own files less write_denied
   *  and order_bounds */
  filesystem: 'none' | 'sandbox' | 'restricted'
  write_denied: string[]
  order_bounds: { read_only: boolean; read: string[] | null; write: string[] | null } | null
  /** the rlimits applied (none: null) */
  resource_limits: Record<string, number> | null
  /** the deadline (none: null) and where it came from */
  timeout_s: number | null
  timeout_source: TimeoutSource | null
  /** the bytes of each stream kept at most (none: null) */
  output_cap_bytes: number | null
}

/** Where a command was asked to run, where it runs and why (policy/access.ts AccessDecision, plus the restrictions). */
export interface AccessReport { requested_access: AccessMode; effective_access: AccessMode; access_reasons: AccessReason[] }

/** Who started a command, kept on its execution record (isolation.launched_by): a run's own tool, an approved
 *  proposal, the connector's route. A record without it is of an older build: its launcher is unknown, and nothing
 *  that rests on the launcher (a later run of the same conversation working beside it) is granted for it. */
export type CommandLauncher = 'run' | 'approval' | 'connector'

/** The launcher a record names, or null (unknown). */
export function launcherOf(execution: { isolation?: Record<string, unknown> | null } | null): CommandLauncher | null {
  const v = execution?.isolation?.launched_by
  return v === 'run' || v === 'approval' || v === 'connector' ? v : null
}

export interface ProcessSpec {
  /** A run-level remote lease borrowed by this job. Only the run owner releases it after all jobs finish. */
  remote_lease?: LeaseProof
  /** who starts it: recorded with the execution (launcherOf) */
  launched_by?: CommandLauncher | null
  command: string
  cwd: string
  /** the sandbox's rules: needed in the sandbox, not read for a Full access command */
  sandbox?: Sandbox
  project_id: string
  run_id?: string | null
  workspace_id?: string | null
  tool_call_id?: string | null
  kind?: string
  /** the deadline: the process group is killed once it passes. Omitted or null: none with Full access; the sandbox's
   *  SANDBOX_DEFAULT_TIMEOUT_S in the sandbox */
  timeout_s?: number | null
  timeout_source?: TimeoutSource
  /** the bytes of each stream its log keeps at most (what passes is counted and not kept). Omitted or null: none
   *  with Full access; SANDBOX_DEFAULT_OUTPUT_CAP_BYTES in the sandbox */
  output_cap_bytes?: number | null
  env_passthrough?: string[]
  env_extra?: Record<string, string>
  /** Full access only: the restrictions chosen for this command that the OS holds on the host (the network off,
   *  read-only paths, a work order's bounds) — and nothing else of the sandbox's. A restriction the runtime cannot be
   *  shown to hold refuses the command (HostRestrictionUnavailable) */
  host_restrictions?: HostRestrictions | null
  /** what the caller decided about the access (recorded with the execution, returned with its result) */
  access_report?: AccessReport | null
  /** where the command runs (contract/modes.ts): the sandbox (the default) or the host, as the user (Full access). A
   *  function is read once, synchronously, as the start begins — the latest the session, the run and the approval can
   *  say — and the start is counted as the session's from that moment until its process is followed (so an access
   *  change waits for it: api/gate.ts) */
  access?: AccessMode | (() => AccessMode)
}

/** A spec with its defaults filled (ProcessManager.start). */
type StartSpec = Omit<ProcessSpec, 'timeout_s' | 'timeout_source' | 'output_cap_bytes'> & { kind: string; timeout_s: number | null; timeout_source: TimeoutSource | null; output_cap_bytes: number | null; env_passthrough: string[]; env_extra: Record<string, string>; run_id: string | null; workspace_id: string | null; tool_call_id: string | null }

/** Why a stream's output was not all kept: the cap, or its log could not be written (a full disk). */
type OutputLoss = 'cap' | 'log_write_failed'

interface Live {
  xid: string
  proc: ChildProcess
  stdout_path: string
  stderr_path: string
  started: number
  spec: StartSpec
  done: Promise<void>
  finish: () => void
  finished: boolean
  cancel_requested: boolean
  truncated: boolean
  /** bytes each stream's log kept */
  bytes_out: number
  bytes_err: number
  /** bytes each stream carried, kept or not */
  seen_out: number
  seen_err: number
  /** why a stream's output was not all kept (null: all of it was) */
  loss_out: OutputLoss | null
  loss_err: OutputLoss | null
  /** the host-restricted profile written for it (removed once it ends) */
  profile: string | null
  exited: boolean
  /** whatever it left running was looked for until none was found (its scratch is then nobody's) */
  reaped: boolean
  /** the sandboxed command's own scratch folder (made for it alone; removed once it and what it left are gone) */
  scratch: string | null
  home: string
  /** where it runs: sandbox, or full (the host, as the user) */
  access: AccessMode
  /** the unique ids of the command's process and every descendant seen so far (macOS: the kernel's lineage) */
  lineage: Set<bigint>
}

/** What a lineage tick gives a waiting watch: its lineage read from a fresh table, or the failure of the reading made
 *  on its behalf (its own, as when every command read alone). */
type LineageOutcome = { failed: false } | { failed: true; error: unknown }

/** One lineage tick (ProcessManager.nextLineageTick): the watches waiting for it, in the order they asked, each with
 *  how it is told the outcome; and its timer. */
interface LineageTick {
  waiting: Map<Live, (outcome: LineageOutcome) => void>
  timer: ReturnType<typeof setTimeout>
}

/** A page's text by the characters that end in it: the byte cursor stays a byte cursor, and a character cut by a
 *  page edge is given whole to the page holding its last byte (its first bytes are read from just before the page)
 *  — so pages read from 0 by next_offset join into the exact text, whatever their size, even one smaller than a
 *  character (that page's text is then empty, and the reader goes on). A byte that begins no valid character is
 *  U+FFFD where it stands; a character still incomplete where a finished stream ends (the output cap cut it) is
 *  U+FFFD too. A page that starts inside a character (an offset not reached by next_offset) shows that character
 *  if the page completes it. */
export function pageText(before: Uint8Array, page: Uint8Array, final: boolean): string {
  const bytes = Buffer.concat([before, page])
  const start = before.length
  const lengthOf = (b: number): number => (b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0)
  // where the character holding the page's first byte begins (a lead byte at most three back)
  let i = start
  for (let back = 1; back <= Math.min(3, start); back += 1) {
    const lead = bytes[start - back]!
    if ((lead & 0xc0) === 0x80) continue
    if (lengthOf(lead) > back) i = start - back
    break
  }
  let out = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  while (i < bytes.length) {
    const n = lengthOf(bytes[i]!)
    if (n === 0) { if (i >= start) out += '\uFFFD'; i += 1; continue }
    if (i + n > bytes.length) {
      // the character goes on past the page: the page holding its last byte has it; a finished stream ending here has none
      if (final) out += '\uFFFD'
      break
    }
    let piece: string | null
    try { piece = decoder.decode(bytes.subarray(i, i + n)) } catch { piece = null }
    if (piece === null) { if (i >= start) out += '\uFFFD'; i += 1; continue }
    if (i + n > start) out += piece
    i += n
  }
  return out
}

/** Where a command finds the host's Rust toolchains. Its HOME is the workspace's own, where rustup would find none
 *  and download one unasked (a gigabyte and more): rustup reads the person's own toolchains where they are
 *  installed (read-only, as every host path outside the workspace is), and never installs one on its own — a
 *  missing toolchain is said, not fetched. Cargo's home stays under the command's HOME: cargo writes its registry
 *  cache and locks there. */
export function toolchainEnv(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Record<string, string> {
  const out: Record<string, string> = { RUSTUP_AUTO_INSTALL: '0' }
  const rustupHome = env.RUSTUP_HOME || join(home, '.rustup')
  if (existsSync(rustupHome)) out.RUSTUP_HOME = rustupHome
  return out
}

/** The directory as a real one at its path: a link or a file left there by an earlier command (a HOME the sandbox
 *  writes is a HOME it could replace with a link to another workspace's) is removed, never followed. */
function realDirectory(path: string): void {
  let entry: ReturnType<typeof lstatSync> | null
  try { entry = lstatSync(path) } catch { entry = null }
  if (entry !== null && !entry.isDirectory()) unlinkSync(path)
  mkdirSync(path, { recursive: true })
}

/** Why a sandboxed command ended at one of the sandbox's resource limits, when its end says so (only commands that ran
 *  under them: a Full access command has none): the limit, its configured value and how to go on. A signal the
 *  process died of is certain; the status a shell reports for it (128 + the signal) may also be a program's own exit
 *  status, so that is said as likely (`certain: false`); the limits refused before the command ran are known by the
 *  harness's own line on stderr. Anything else (an exit status, a message) is not read as a limit. */
export function limitStop(exitCode: number | null, stderr: string, limits: ResourceLimits | null): { code: string; detail: string; next_step: string; certain: boolean } | null {
  if (limits === null || exitCode === null) return null
  const fixed = 'The sandbox sets it for every command (execution/isolation.ts DEFAULT_LIMITS); no setting changes it.'
  const go = 'Run it with Full access (the person switches the session in oasis-code: no resource limit of the harness\'s there), or split the work into smaller commands.'
  if (exitCode === -24 || exitCode === 152) {
    const certain = exitCode === -24
    return { code: 'cpu_limit', certain, next_step: go,
      detail: `${certain ? 'It was killed by SIGXCPU' : 'Its exit status 152 is what a shell reports for a process killed by SIGXCPU (signal 24) — likely, not certain: a program may exit 152 on its own'}: the sandbox's CPU-time limit of ${limits.cpu_seconds} s (CPU seconds the process used, not the time it ran). ${fixed}` }
  }
  if (exitCode === -25 || exitCode === 153) {
    const certain = exitCode === -25
    return { code: 'file_size_limit', certain, next_step: go,
      detail: `${certain ? 'It was killed by SIGXFSZ' : 'Its exit status 153 is what a shell reports for a process killed by SIGXFSZ (signal 25) — likely, not certain: a program may exit 153 on its own'}: a file it wrote reached the sandbox's file-size limit of ${limits.file_size_bytes.toLocaleString('en-US')} bytes. ${fixed}` }
  }
  if (exitCode === LIMITS_REFUSED_EXIT && stderr.includes(LIMITS_REFUSED_LINE)) {
    return { code: 'limits_refused', certain: true, next_step: 'Run it with Full access, or start oasis-code where these limits can be set (a hard limit of the account below them refuses them: ulimit -H -a shows them).',
      detail: `The sandbox's resource limits (CPU ${limits.cpu_seconds} s, file size ${limits.file_size_bytes.toLocaleString('en-US')} bytes, ${limits.open_files} open files) could not be applied on this host, so the command did not run; the shell's reason is on stderr.` }
  }
  return null
}

export interface RemoteProcessDriver {
  start(spec: ProcessSpec, workspace: Workspace): Promise<Execution>;
  has(id: string): boolean; pending(id: string): boolean; connected(id: string): boolean;
  startIdentity?(id: string): { job_id: string | null; operation_id: string; finalized: boolean; refused: boolean } | null;
  recoverStart?(id: string): Promise<string | null>;
  wait(id: string, timeout: number | null): Promise<Execution | null>;
  readOutput(id: string, stream: 'stdout' | 'stderr', offset: number, limit: number): Promise<Record<string, unknown>>;
  summary(id: string): Promise<Record<string, unknown>>;
  stop(id: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export class ProcessManager {
  remoteDriver?: RemoteProcessDriver
  preserveRemoteOnShutdown = false
  private readonly connectionListeners: ((id: string, connected: boolean) => void)[] = []
  isRemoteExecution(id: string): boolean { return this.conn.get('SELECT execution_id FROM remote_jobs WHERE execution_id=?', [id]) !== null }
  remoteConnected(id: string): boolean { return this.remoteDriver?.connected(id) === true }
  onConnection(listener: (id: string, connected: boolean) => void): void { this.connectionListeners.push(listener) }
  emitRemoteOutput(event: { execution_id: string; stream: 'stdout' | 'stderr'; bytes: Buffer }): void { for (const listener of this.outputListeners) listener(event.execution_id, event.stream, event.bytes) }
  emitRemoteEnd(id: string): void { for (const listener of this.endListeners) listener(id) }
  emitRemoteConnection(id: string, connected: boolean): void { for (const listener of this.connectionListeners) listener(id, connected) }
  async readOutputAsync(id: string, stream = 'stdout', offset = 0, limit = 16384): Promise<Record<string, unknown>> {
    if (!this.isRemoteExecution(id)) return this.readOutput(id, stream, offset, limit) as unknown as Record<string, unknown>
    if (!this.remoteDriver) throw new RemoteRefused('remote_unavailable', 'Remote output is unavailable; local fallback refused.', 503)
    const start = Math.max(0, Math.trunc(offset)), which = stream === 'stderr' ? 'stderr' : 'stdout'
    const observed = await this.remoteDriver.readOutput(id, which, start, Math.max(1, Math.trunc(limit)))
    const execution = repo.getExecution(this.conn, id)!
    const identity = { target: execution.target, remote: execution.remote, connection_state: this.remoteConnected(id) ? 'connected' : execution.connection_state ?? 'unknown' }
    if (observed.available === false) return { ...observed, ...identity, execution_id: id, stream: which, offset: start, returned_bytes: 0, total_bytes: null,
      next_offset: start, eof: false, running: this.isRunning(id), status: 'unknown', exit_code: null, truncated_at_cap: false, text: '' }
    return { exit_code: execution.exit_code, truncated_at_cap: execution.truncated, ...observed, ...identity }
  }
  async summaryAsync(id: string): Promise<Record<string, unknown>> {
    if (!this.isRemoteExecution(id) || !this.remoteDriver?.has(id)) return this.summary(id)
    const summary = await this.remoteDriver.summary(id), execution = repo.getExecution(this.conn, id)
    const ws = execution?.workspace_id ? repo.getWorkspace(this.conn, execution.workspace_id) : null
    return { ...summary, target: ws?.target, remote: ws?.remote, requested_access: execution?.isolation.requested_access ?? 'full', effective_access: 'full', isolation: 'none' }
  }
  async stopAsync(id: string): Promise<Record<string, unknown>> {
    if (!this.isRemoteExecution(id)) return { stopped: this.stop(id) }
    if (!this.remoteDriver) return { stopped: false, status: 'unknown', code: 'remote_unavailable' }
    return this.remoteDriver.stop(id)
  }
  readonly limits: ResourceLimits
  readonly live = new Map<string, Live>()
  readonly logs_dir: string
  /** macOS: the developer-tool shims' lookup cache, warmed on the host so a sandboxed `python3` or `git` never has to
   *  write it (the write is refused there, and the shim says so on stderr) */
  readonly xcrun: XcrunWarmer
  /** the kernel's fork reports for the running commands (macOS) */
  private readonly forks = new ForkWatcher()
  /** the executions the fork watcher was asked to follow and that have not ended: their records say what it is doing */
  private readonly forkWatched = new Set<string>()
  /** what hears a command's output as it arrives — all of it, the part past the log's cap too — and its end, once
   *  its record says how it ended (the watches) */
  private readonly outputListeners: ((xid: string, stream: 'stdout' | 'stderr', chunk: Buffer) => void)[] = []
  private readonly endListeners: ((xid: string) => void)[] = []

  /** The environment a Full access command's shell starts from (execution/host_env.ts): the backend's own. Replaced
   *  in the tests by a fixture's (its own HOME and startup files), never the person's. */
  hostEnvironment: () => Record<string, string | undefined> = () => ({ ...process.env })

  /** The user's login shell's snapshot (execution/host_env.ts): taken as a Full access command starts, kept for
   *  SNAPSHOT_TTL_MS; one taking at a time. */
  private loginSnapshot: LoginSnapshot | null = null
  private snapshotting: Promise<LoginSnapshot | null> | null = null

  /** The starts between the moment their access was read and the moment their process is followed (or failed), by a
   *  token: what they are for. They count as running commands of their session (an access change waits for them). */
  private readonly starting = new Map<string, { workspace_id: string | null; run_id: string | null; stop_requested?: boolean }>()

  /** How what a command left running is signalled: replaced in the tests to stand for a kill not yet landed. */
  killProcess: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => { process.kill(pid, signal) }

  /** How a command's output reaches its log file: replaced in the tests to stand for a disk that is full. */
  logWrite: (fd: number, data: Uint8Array) => number = writeSync

  /** How the kernel's process table is read for the lineages (every process this user can read, with its identity):
   *  replaced in the tests to count the readings. */
  processIdentities: () => ProcessIdentity[] = identities

  /** The lineage tick the running commands' watches wait for (null: none waits) — LineageTick. */
  private lineageTick: LineageTick | null = null

  constructor(readonly settings: Settings, readonly conn: Conn, readonly store: AssetStore, readonly runtime: IsolationRuntime,
    readonly report: IsolationReport, limits?: ResourceLimits, xcrun?: XcrunWarmer) {
    this.limits = limits ?? DEFAULT_LIMITS
    this.logs_dir = settings.logs_dir
    mkdirSync(this.logs_dir, { recursive: true })
    this.xcrun = xcrun ?? new XcrunWarmer()
    // the watcher starts on its own thread: what each running command's record says follows what it turns out to do
    this.forks.onState = () => { for (const xid of this.forkWatched) this.noteLineage(xid) }
  }

  /** What follows a command's children, as it is now: the watcher once its thread runs, the tick alone when it did not
   *  start (or has not yet started) — never the watcher before it reported ready. */
  private noteLineage(xid: string): void {
    const how = this.forks.state === 'ready' ? 'fork watcher'
      : this.forks.state === 'starting' ? 'tick only (the fork watcher is starting)'
      : this.forks.state === 'failed' ? 'tick only (the fork watcher did not start)'
      : 'tick only'
    repo.noteExecutionLineage(this.conn, xid, how)
  }

  /** A workspace's sandbox folder: what its commands and tools keep beside the worktree — its HOME and its temporary
   *  folder — shared by every command and run of the workspace, kept across runs and restarts, never part of the
   *  worktree (so never of a checkpoint, a diff or an integration), and another workspace's is another's. */
  sandboxDir(workspaceId: string): string {
    return join(this.settings.sandboxes_dir, workspaceId)
  }

  /** The HOME a command runs under: one per workspace (its commands share it, as they share the worktree; another
   *  workspace's is another), so the developer-tool shims' cache — keyed by HOME — can be warmed for it once; a
   *  command of no workspace gets the scratch's own. */
  homeFor(workspaceId: string | null, scratch: string): string {
    return workspaceId ? join(this.sandboxDir(workspaceId), 'home') : join(scratch, 'home')
  }

  /** The temporary folder of a workspace: a command's $TMPDIR and the one absolute location the file tools reach;
   *  what is put there stays for the workspace's later commands and runs (a command of no workspace gets the
   *  scratch's own, gone with it). */
  tempFor(workspaceId: string | null, scratch: string): string {
    return workspaceId ? join(this.sandboxDir(workspaceId), 'tmp') : join(scratch, 'tmp')
  }

  /** The temporary folder as a real directory at its path (made, or a link left there replaced): what a run needs
   *  before its first tool. */
  ensureTemp(workspaceId: string): string {
    const tmp = this.tempFor(workspaceId, '')
    realDirectory(tmp)
    return tmp
  }

  /** Whether a command of the workspace still runs (its sandbox folder is in use). */
  liveForWorkspace(workspaceId: string): boolean {
    return this.runningInWorkspace(workspaceId).length > 0
  }

  /** The executions of the workspace whose command still runs (a run's command may outlive its run). */
  runningInWorkspace(workspaceId: string): string[] {
    const local = [...this.live.values()].filter((live) => live.spec.workspace_id === workspaceId && !live.exited).map((live) => live.xid)
    const remote = this.conn.all(repo.REMOTE_EXECUTIONS_OF_WORKSPACE_SQL, [workspaceId]).map(r => String(r.execution_id)).filter(id => this.isRunning(id))
    return [...local, ...remote]
  }

  /** The commands of a session still running or being started: any workspace of the session (a child's included) or
   *  a run of it — what an access change waits for. A command keeps the access it started with; nothing is stopped. */
  runningForSession(sessionId: string): string[] {
    const ofSession = (workspaceId: string | null | undefined, runId: string | null | undefined): boolean =>
      (!!workspaceId && repo.getWorkspace(this.conn, workspaceId)?.session_id === sessionId) || (!!runId && repo.getRun(this.conn, runId)?.session_id === sessionId)
    const out = [...this.live.values()].filter((live) => !live.exited && ofSession(live.spec.workspace_id, live.spec.run_id)).map((live) => live.xid)
    for (const [token, s] of this.starting) if (ofSession(s.workspace_id, s.run_id)) out.push(token)
    // Drive the lookup from the remote subset, not every execution (whose output can occupy overflow pages).
    // SQLite may otherwise choose an executions scan, even when there are no remote jobs. Preserve execution
    // insertion order, and keep the same ownership and live/unknown checks below — this is not a status filter.
    const remote = this.conn.all('SELECT e.id,e.workspace_id,e.run_id FROM remote_jobs r CROSS JOIN executions e ON e.id=r.execution_id ORDER BY e.rowid')
    for (const row of remote) if (ofSession(row.workspace_id as string | null, row.run_id as string | null) && this.isRunning(String(row.id))) out.push(String(row.id))
    return out
  }

  /** Remove a workspace's sandbox folder (its HOME and temporary folder), refused while a command of it runs. */
  removeSandbox(workspaceId: string): void {
    if (this.liveForWorkspace(workspaceId)) throw new Error(`a command of workspace ${workspaceId} is still running; stop it before removing its temporary folder`)
    rmSync(this.sandboxDir(workspaceId), { recursive: true, force: true })
  }

  /** The processes the commands of an earlier life of the harness left behind (their executions are lost now),
   *  killed — the recorded command process and its process group while it is still that process (it outlives the
   *  harness: it runs detached, and a shell's environment is not readable to find it by), what carries the execution
   *  id, and what descends from the command process by the kernel's lineage; how many. At startup, and on a Stop of
   *  a lost execution. */
  reapLost(xids: string[]): number {
    xids = xids.filter(id => !this.isRemoteExecution(id))
    if (!xids.length) return 0
    const known = new Set<bigint>()
    const roots: number[] = []
    for (const xid of xids) {
      const recorded = (repo.getExecution(this.conn, xid)?.isolation ?? {}) as RecordedRoot
      if (typeof recorded.root_uniqueid === 'string' && /^\d+$/.test(recorded.root_uniqueid)) known.add(BigInt(recorded.root_uniqueid))
      const root = liveRoot(recorded)
      if (root !== null) roots.push(root)
    }
    // everything is found before anything is killed: a killed intermediate would break the lineage to what it made
    // pid → the unique id it was found as (null: found by the execution id it carries, read just now)
    const targets = new Map<number, bigint | null>()
    for (const s of strayProcesses(xids)) targets.set(s.pid, null)
    if (known.size) for (const p of descendantsOf(known)) targets.set(p.pid, p.uniqueid)
    let killed = 0
    for (const root of roots) {
      // the group the command's process leads (it was started as its own group), or the process alone when it left it
      try { process.kill(-root, 'SIGKILL'); killed += 1 } catch {
        try { process.kill(root, 'SIGKILL'); killed += 1 } catch { /* gone */ }
      }
      targets.delete(root)
    }
    for (const [pid, uniqueid] of targets) {
      // a pid read from the lineage is killed only while it is still that process (a pid is reused, a unique id never)
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue
      if (uniqueid !== null && identityOf(pid)?.uniqueid !== uniqueid) continue
      try { process.kill(pid, 'SIGKILL'); killed += 1 } catch { /* gone */ }
    }
    return killed
  }

  /** The commands' descendants read into their lineages now, by their recorded creators, all from one reading of the
   *  process table — the given one, else one made now (never one kept from an earlier call; made as before, whether
   *  or not a lineage is known). The fork watcher adds the children it saw being made. */
  private trackLineage(lives: Iterable<Live>, table?: ProcessIdentity[]): void {
    const read = table ?? this.processIdentities()
    for (const live of lives) if (live.lineage.size) descendantsOf(live.lineage, read)
  }

  /** The next lineage tick, for a running command's watch: one pending tick at a time, made by the first watch that
   *  waits for it and joined by every watch that waits before it fires (so a timer exists only while a watch waits).
   *  It resolves to this watch's outcome and never rejects. A command whose process has exited is not waited for (its
   *  watch goes on by its exit and reads its own table). */
  private nextLineageTick(live: Live): Promise<LineageOutcome> {
    if (live.exited) return new Promise<LineageOutcome>(() => {})
    let tick = this.lineageTick
    if (tick === null) {
      const made: LineageTick = { waiting: new Map(), timer: setTimeout(() => this.fireLineageTick(made), LINEAGE_TICK_MS) }
      tick = this.lineageTick = made
    }
    const joined = tick
    return new Promise<LineageOutcome>((resolve) => { joined.waiting.set(live, resolve) })
  }

  /** The tick fires: the table read once, fresh, for every waiting watch whose process still runs, as if the first of
   *  them read it for all. Each reading that fails is the failure of the one it was made for — the first still unserved
   *  — and goes to that watch alone, which fails as it did when it read alone; the table is read again, fresh, for the
   *  rest, and one reading that succeeds serves all of them. So every failed reading belongs to exactly one command, a
   *  failure is never told to the others, never dropped, never thrown out of the timer. */
  private fireLineageTick(tick: LineageTick): void {
    if (this.lineageTick !== tick) return
    this.lineageTick = null
    const unserved = [...tick.waiting.keys()].filter((live) => !live.exited)
    while (unserved.length) {
      try {
        this.trackLineage(unserved)
      } catch (error) {
        tick.waiting.get(unserved.shift()!)!({ failed: true, error })
        continue
      }
      for (const live of unserved) tick.waiting.get(live)!({ failed: false })
      break
    }
  }

  /** A command whose process exited no longer waits for the tick: the tick's timer goes with the last one waiting
   *  (its watch goes on by its exit, never by this tick). */
  private leaveLineageTick(live: Live): void {
    const tick = this.lineageTick
    if (tick === null || !tick.waiting.delete(live) || tick.waiting.size > 0) return
    clearTimeout(tick.timer)
    this.lineageTick = null
  }

  /** Once the command's own process is gone: whatever it left running is found and killed, in a few rounds until
   *  nothing is found; the distinct processes killed. */
  private async reapStrays(live: Live): Promise<{ killed: number; clean: boolean }> {
    const killed = new Set<number>()
    const root = live.proc.pid
    let clean = false
    for (let round = 0; round < STRAY_ROUNDS; round += 1) {
      // by the execution id they carry, by the parent chain, and by the kernel's lineage (a child that left the group,
      // cleared its environment and was handed to launchd still names its creator)
      const targets = new Map<number, bigint | null>()
      for (const s of strayProcesses([live.xid], root !== undefined ? [root] : [])) if (s.pid !== root) targets.set(s.pid, null)
      if (live.lineage.size) {
        const table = this.processIdentities()
        this.trackLineage([live], table)
        for (const p of table) if (p.pid !== root && live.lineage.has(p.uniqueid)) targets.set(p.pid, p.uniqueid)
      }
      // what runs no more: exited and waiting to be reaped (the group's own, killed with it), or a pid read from the
      // lineage that is no longer that process (a pid is reused, a unique id never). One signalled before but still
      // found running is a live target still: a kill sent is not a process seen gone
      for (const [pid, uniqueid] of [...targets]) {
        if (exitedAwaitingReap(pid) || (uniqueid !== null && identityOf(pid)?.uniqueid !== uniqueid)) targets.delete(pid)
      }
      // nothing of it is left running: only now is what it could write (its scratch) nobody's
      if (!targets.size) { clean = true; break }
      for (const pid of targets.keys()) {
        try { this.killProcess(pid, 'SIGKILL'); killed.add(pid) } catch { /* gone */ }
      }
      // a killed process is a zombie or gone by the next reading: a breath, longer each round it is not
      await sleep(5 * 2 ** round)
    }
    return { killed: killed.size, clean }
  }

  onOutput(listener: (xid: string, stream: 'stdout' | 'stderr', chunk: Buffer) => void): void { this.outputListeners.push(listener) }

  onEnd(listener: (xid: string) => void): void { this.endListeners.push(listener) }

  requireFull(): void {
    if (this.report.enforcement !== 'full') {
      throw new IsolationUnavailable(
        `isolated execution needs full enforcement; ${this.report.runtime} reports '${this.report.enforcement}' `
        + `(${this.report.diagnostics.join('; ')}). Nothing runs unisolated.`)
    }
  }

  /** The shell line that applies the rlimits before the command (no preexec hook here; the shell's ulimit does it,
   *  and a limit it refuses leaves the command unrun — see isolation.limitedArgv). */
  private limitedArgv(command: string): string[] {
    return limitedArgv(command, this.limits)
  }

  async start(specIn: ProcessSpec): Promise<Execution> {
    // the access is read now, before anything awaits, and the start counts as the session's until its process is
    // followed: an access change cannot land between this reading and the process (api/gate.ts waits for it)
    const access: AccessMode = typeof specIn.access === 'function' ? specIn.access() : specIn.access === 'full' ? 'full' : 'sandbox'
    // the deadline and the output cap: what the caller gave; else none with Full access, the sandbox's own in it
    const timeout = specIn.timeout_s ?? (access === 'full' ? null : SANDBOX_DEFAULT_TIMEOUT_S)
    const spec: StartSpec = {
      kind: 'command', env_passthrough: ['PATH', 'LANG', 'LC_ALL', 'TERM'], env_extra: {}, run_id: null, workspace_id: null, tool_call_id: null, ...specIn,
      timeout_s: timeout,
      timeout_source: timeout === null ? null : specIn.timeout_s != null ? (specIn.timeout_source ?? 'call') : 'default',
      output_cap_bytes: specIn.output_cap_bytes ?? (access === 'full' ? null : SANDBOX_DEFAULT_OUTPUT_CAP_BYTES),
    }
    const token = `starting-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const entry: { workspace_id: string | null; run_id: string | null; stop_requested?: boolean } = { workspace_id: spec.workspace_id ?? null, run_id: spec.run_id ?? null }
    this.starting.set(token, entry)
    try {
      const workspace = spec.workspace_id ? repo.getWorkspace(this.conn, spec.workspace_id) : null
      let execution: Execution
      if (workspace?.target?.kind === 'ssh') {
        if (access !== 'full') throw new RemoteRefused('sandbox_unavailable', 'Remote sandbox enforcement is unavailable.')
        if (hostRestricted(spec.host_restrictions)) throw new RemoteRefused('restriction_unavailable', 'Remote host restrictions cannot be enforced.')
        if (!this.remoteDriver) throw new RemoteRefused('remote_unavailable', 'Remote execution driver unavailable; nothing ran locally.', 503)
        execution = await this.remoteDriver.start({ ...spec, timeout_source: spec.timeout_source ?? undefined }, workspace)
      } else execution = access === 'full' ? await this.startOnHost(spec) : await this.startSandboxed(spec)
      // its run was stopped while this process was being made (stopAllForRun saw no process of it yet): stopped now, so
      // nothing of a stopped run goes on unseen — after its end, outside its folder's lease
      if (entry.stop_requested) this.stop(execution.id)
      return execution
    } finally {
      this.starting.delete(token)
    }
  }

  /** Whether this host's runtime holds the restrictions chosen for a Full access command — what its probe verified;
   *  else the command is refused, never run without them nor moved into the whole sandbox. */
  private requireHostRestrictions(r: HostRestrictions): void {
    const chosen = [!r.network ? 'the network denied' : null, r.write_deny.length ? 'writes denied to chosen paths' : null,
      r.bounds ? 'a work order\'s bounds' : null].filter(Boolean).join(', ')
    if (typeof this.runtime.hostCommand !== 'function') {
      throw new HostRestrictionUnavailable(`the ${this.runtime.name} runtime cannot hold a restriction on a Full access command on this host (${chosen}); nothing ran`)
    }
    const unverified = [
      !r.network && !this.report.network_isolation ? 'the network denial' : null,
      (r.write_deny.length > 0 || !!r.bounds) && !this.report.filesystem_isolation ? 'the filesystem rules' : null,
    ].filter(Boolean)
    if (unverified.length) {
      throw new HostRestrictionUnavailable(`${this.report.runtime} has not verified ${unverified.join(' and ')} on this host (${this.report.enforcement}: ${this.report.diagnostics.join('; ')}); a Full access command with ${chosen} does not run without them`)
    }
  }

  /** What a command is held to, as recorded with it (CommandRestrictions). */
  private restrictionsOf(spec: StartSpec, access: AccessMode, restrictions: HostRestrictions | null, box: Sandbox | null): CommandRestrictions {
    const limits = { timeout_s: spec.timeout_s, timeout_source: spec.timeout_source, output_cap_bytes: spec.output_cap_bytes }
    const boundsOf = (b: Sandbox['bounds']) => b && (b.read_only || b.read !== null || b.write !== null) ? { read_only: b.read_only, read: b.read, write: b.write } : null
    if (access === 'full') {
      const bounds = boundsOf(restrictions?.bounds ?? null)
      const writeDenied = [...new Set((restrictions?.write_deny ?? []).map(resolveRealPath))]
      return {
        environment: 'host', enforced_by: restrictions ? this.runtime.name : 'none', network: restrictions && !restrictions.network ? 'denied' : 'allowed',
        filesystem: writeDenied.length || bounds ? 'restricted' : 'none', write_denied: writeDenied, order_bounds: bounds, resource_limits: null, ...limits,
      }
    }
    const rlimits: Record<string, number> = { cpu_seconds: this.limits.cpu_seconds, file_size_bytes: this.limits.file_size_bytes, open_files: this.limits.open_files }
    if (process.platform === 'linux') rlimits.address_space_bytes = this.limits.address_space_bytes
    return {
      environment: 'sandbox', enforced_by: this.runtime.name, network: box?.network ? 'allowed' : 'denied', filesystem: 'sandbox',
      write_denied: [...(box?.write_deny ?? [])], order_bounds: boundsOf(box?.bounds ?? null), resource_limits: rlimits, ...limits,
    }
  }

  /** The access record of an execution: what was asked, where it runs and why, what holds it. */
  private accessRecord(spec: StartSpec, access: AccessMode, restrictions: HostRestrictions | null, box: Sandbox | null): Record<string, unknown> {
    return {
      requested_access: spec.access_report?.requested_access ?? access, effective_access: access,
      access_reasons: spec.access_report?.access_reasons ?? [], restrictions: this.restrictionsOf(spec, access, restrictions, box),
      timeout_source: spec.timeout_source, output_cap_bytes: spec.output_cap_bytes,
      ...(spec.launched_by ? { launched_by: spec.launched_by } : {}),
    }
  }

  /** A Full access command: the user's login and interactive shell on the host (execution/host_env.ts), its own
   *  process group and the stray sweep as for any command; no sandbox, no resource limits of the harness's, the user's
   *  HOME and TMPDIR; a deadline and an output cap only when given. Restrictions chosen for it (the network off,
   *  read-only paths, a work order's bounds) are held by the OS around that same shell (isolation.hostProfile), and
   *  nothing else; a shell that cannot be run so, or a restriction the OS cannot be shown to hold, refuses it. */
  private async startOnHost(spec: StartSpec): Promise<Execution> {
    const host = this.hostEnvironment()
    const shell = loginShellOf(host)
    const restrictions = hostRestricted(spec.host_restrictions) ? spec.host_restrictions : null
    if (restrictions !== null) this.requireHostRestrictions(restrictions)
    // what the user's startup files set up: a snapshot of them (taken now if none is fresh), else their own shell
    const snapshot = await this.snapshotFor(shell, host, restrictions !== null)
    const execution = repo.insertExecution(this.conn, {
      run_id: spec.run_id ?? null, workspace_id: spec.workspace_id ?? null, tool_call_id: spec.tool_call_id ?? null, kind: spec.kind ?? 'command', command: spec.command, cwd: spec.cwd,
      // what ran it, said as it is: the host, no enforcement of the harness's (whatever confines the backend itself) —
      // or, with restrictions, the runtime holding those and only those
      isolation: {
        runtime: 'host', fingerprint: restrictions ? this.report.runtime_fingerprint : null, enforcement: restrictions ? 'restricted' : 'none', access_mode: 'full', shell,
        shell_start: snapshot ? 'snapshot' : 'login',
        timeout_s: spec.timeout_s, ...this.accessRecord(spec, 'full', restrictions, null),
      },
      network: restrictions ? restrictions.network : true,
    })
    const extra = { [EXECUTION_ID_VARIABLE]: execution.id, ...(spec.env_extra ?? {}) }
    const env = snapshot ? snapshotCommandEnv(snapshot, extra) : hostCommandEnv(host, extra)
    let argv = snapshot ? snapshotArgv(snapshot, spec.command) : loginShellArgv(shell, spec.command)
    let profile: string | null = null
    if (restrictions !== null) {
      profile = join(this.settings.scratch_dir, 'host-profiles', `${execution.id}.sb`)
      try {
        mkdirSync(dirname(profile), { recursive: true })
        argv = this.runtime.hostCommand!(argv, restrictions, profile)
      } catch (error) {
        this.notApplied(execution.id)
        throw new HostRestrictionUnavailable(`the restrictions could not be prepared (${errorText(error)}); nothing ran`)
      }
    }
    return this.launch(spec, execution, argv, env, host.HOME ?? '', 'full', profile)
  }

  /** The snapshot a Full access command starts from: the kept one while it is fresh and of this shell and HOME; else,
   *  for a command without restrictions, a new one taken now (the startup files read now, as this command starts).
   *  A command with restrictions takes none outside them: without a fresh snapshot it runs in the login shell itself,
   *  inside its restrictions, as before. Null when there is none to use. */
  private async snapshotFor(shell: string, host: Record<string, string | undefined>, restricted: boolean): Promise<LoginSnapshot | null> {
    const kept = this.loginSnapshot
    if (kept && kept.shell === shell && kept.env.HOME === host.HOME && Date.now() - kept.taken_at < SNAPSHOT_TTL_MS) return kept
    if (restricted) return null
    this.snapshotting ??= (async () => {
      const dir = join(this.settings.scratch_dir, 'login-snapshots')
      mkdirSync(dir, { recursive: true })
      const taken = await takeLoginSnapshot(shell, hostCommandEnv(host, {}), dir)
      if (taken) {
        const old = this.loginSnapshot
        this.loginSnapshot = taken
        // a command may be reading the old script as it starts: removed a minute later
        if (old) setTimeout(() => dropSnapshot(old), 60_000).unref?.()
      }
      return taken
    })().finally(() => { this.snapshotting = null })
    return this.snapshotting
  }

  private async startSandboxed(spec: StartSpec): Promise<Execution> {
    this.requireFull()
    if (!spec.sandbox) throw new IsolationUnavailable('a sandboxed command needs its sandbox\'s rules; nothing ran')
    // the command's own scratch, made atomically by the kernel under a name no other start can get (never derived
    // from the clock or a count: two starts in the same millisecond once shared one, and one profile.sb in it)
    mkdirSync(this.settings.scratch_dir, { recursive: true })
    const scratch = mkdtempSync(join(this.settings.scratch_dir, 'x-'))
    // set by launch the moment a process exists: from then on the scratch is the watch's to remove, after the process
    // and whatever it left are seen gone (retire), never this start's — whatever fails after
    const owner = { spawned: false }
    try {
      return await this.startInScratch(spec, spec.sandbox, scratch, owner)
    } catch (error) {
      if (!owner.spawned) this.removeScratch(scratch)
      throw error
    }
  }

  private async startInScratch(spec: StartSpec, sandbox: Sandbox, scratch: string, owner: { spawned: boolean }): Promise<Execution> {
    const home = this.homeFor(spec.workspace_id, scratch)
    const tmp = this.tempFor(spec.workspace_id, scratch)
    realDirectory(home)
    realDirectory(tmp)
    const box: Sandbox = {
      writable: [...sandbox.writable, scratch, home, tmp], write_deny: [...sandbox.write_deny], write_deny_patterns: [...(sandbox.write_deny_patterns ?? [])], read_deny: [...sandbox.read_deny],
      read_allow: [...sandbox.read_allow, scratch, home, tmp], read_deny_within: [...(sandbox.read_deny_within ?? [])],
      read_allow_within: [...(sandbox.read_allow_within ?? [])], pinned: [home, tmp, ...(sandbox.pinned ?? [])], network: sandbox.network,
      bounds: sandbox.bounds ?? null, deny_hardlinks: sandbox.deny_hardlinks === true,
      // the session's exact input files (sandboxForWorkspace from authorizeInputFiles): dropped here, they would be lost
      exact_reads: sandbox.exact_reads ?? null,
    }
    // the workspace's first command waits for the shims' cache to be warm under its HOME (a moment, once)
    await this.xcrun.warm(XCRUN_TOOLS, home).catch(() => [])
    const execution = repo.insertExecution(this.conn, {
      run_id: spec.run_id, workspace_id: spec.workspace_id, tool_call_id: spec.tool_call_id, kind: spec.kind, command: spec.command, cwd: spec.cwd,
      isolation: {
        runtime: this.runtime.name, fingerprint: this.report.runtime_fingerprint, enforcement: this.report.enforcement, access_mode: 'sandbox', scratch, home, tmp,
        timeout_s: spec.timeout_s, ...this.accessRecord(spec, 'sandbox', null, sandbox),
      },
      network: sandbox.network,
    })
    // GIT_OPTIONAL_LOCKS=0: git's optional index refresh (status, diff) is skipped rather than attempted against the
    // read-only metadata; nothing a command needs is lost
    const env = scrubbedEnv(spec.env_passthrough ?? [], { ...toolchainEnv(), HOME: home, TMPDIR: tmp, [EXECUTION_ID_VARIABLE]: execution.id, GIT_OPTIONAL_LOCKS: '0', ...(spec.env_extra ?? {}) })
    const command = this.runtime.command(this.limitedArgv(spec.command), box, join(scratch, 'profile.sb'))
    return this.launch(spec, execution, command, env, home, 'sandbox', null, scratch, owner)
  }

  /** An execution whose process was never made: recorded as failed and not applied. */
  private notApplied(xid: string): void {
    repo.finishExecution(this.conn, xid, {
      status: 'failed', exit_code: null, timed_out: false, cancelled: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null,
      stdout_bytes: 0, stderr_bytes: 0, duration_ms: 0,
    })
    repo.setExecutionNotApplied(this.conn, xid)
  }

  /** The process of an execution recorded just now: made in its own session and process group, followed, logged. */
  private async launch(spec: StartSpec, execution: Execution, command: string[], env: Record<string, string>, home: string, access: AccessMode, profile: string | null, scratch: string | null = null, owner: { spawned: boolean } = { spawned: false }): Promise<Execution> {
    const stdoutPath = join(this.logs_dir, `${execution.id}.stdout`)
    const stderrPath = join(this.logs_dir, `${execution.id}.stderr`)
    repo.startExecution(this.conn, execution.id)
    let proc: ChildProcess
    try {
      // detached: its own session and process group, so a timeout or a stop kills the whole tree
      proc = spawn(command[0]!, command.slice(1), { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', () => { owner.spawned = true; resolve() })
        proc.once('error', reject)
      })
    } catch (error) {
      this.notApplied(execution.id)
      if (profile !== null) { try { unlinkSync(profile) } catch { /* never written */ } }
      throw new Error(`could not start the process: ${(error as Error).message}`)
    }
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const live: Live = {
      xid: execution.id, proc, stdout_path: stdoutPath, stderr_path: stderrPath, started: monotonic(), spec, done, finish, finished: false,
      cancel_requested: false, truncated: false, bytes_out: 0, bytes_err: 0, seen_out: 0, seen_err: 0, loss_out: null, loss_err: null, profile,
      exited: false, reaped: false, scratch, home, access, lineage: new Set(),
    }
    // followed before anything else can fail: whatever goes wrong from here (a record that cannot be written), the
    // process is watched, stopped with its run and reaped, and its scratch goes only once it is seen gone
    let root: ReturnType<typeof identityOf> = null
    try { root = proc.pid !== undefined ? identityOf(proc.pid) : null } catch { root = null }
    if (root !== null) live.lineage.add(root.uniqueid)
    this.live.set(execution.id, live)
    const pumps = [this.pump(live, proc.stdout!, stdoutPath, 'out'), this.pump(live, proc.stderr!, stderrPath, 'err')]
    // a record that cannot be written (a full disk) is said, never a harness gone: the command's waiters are let go
    void this.watch(live, pumps).catch((error) => {
      console.error(`[processes] ${live.xid}: its end could not be recorded (${errorText(error)}); it is found again at the next start`)
      if (!live.finished) { live.finished = true; this.retire(live); live.finish() }
    })
    try {
      // the command's process, known from its first moment (sandbox-exec and the shells exec into the command, so its
      // unique id is the command's), and recorded for a restart to find what it left
      if (root !== null) {
        // every child its processes make, as the kernel reports it (a brief intermediate included)
        this.forks.watch(execution.id, proc.pid!, (uniqueid) => { live.lineage.add(uniqueid) })
        // whether the kernel's fork reports reach this command (a watcher that could not start leaves the 50 ms tick);
        // kept up to date while the command runs
        this.forkWatched.add(execution.id)
        this.noteLineage(execution.id)
      }
      // the process a restart kills if the harness is lost while the command runs, and how to know it is still that one
      const identity = proc.pid !== undefined ? processIdentity(proc.pid) : null
      if (identity !== null) repo.noteExecutionRoot(this.conn, execution.id, { pid: proc.pid!, identity, uniqueid: root?.uniqueid.toString() ?? null })
    } catch (error) {
      // the command runs and is followed by this life of the harness; only what a restart would find it by is missing
      console.error(`[processes] ${execution.id}: its process could not be fully recorded (${errorText(error)}); it is followed and reaped as it runs`)
    }
    return repo.getExecution(this.conn, execution.id)!
  }

  // -- the streams and the watch ---------------------------------------------

  private pump(live: Live, stream: NodeJS.ReadableStream, path: string, which: 'out' | 'err'): Promise<void> {
    // no cap: every byte goes to the log on disk (read back in bounded pages, never held here)
    const cap = live.spec.output_cap_bytes ?? Number.POSITIVE_INFINITY
    let written = 0
    const lose = (why: OutputLoss) => {
      live.truncated = true
      if (which === 'out') live.loss_out ??= why
      else live.loss_err ??= why
    }
    // a log that cannot be written (a full disk) stops being kept, said once: the command goes on, its stream is read to
    // its end (counted, not kept), and the harness stays up
    const lost = (error: unknown) => {
      lose('log_write_failed')
      console.error(`[processes] ${live.xid}: its ${which === 'out' ? 'stdout' : 'stderr'} log could not be written (${errorText(error)}); the command goes on, its output from here is not kept`)
    }
    let fd: number | null = null
    try { fd = openSync(path, 'w') } catch (error) { lost(error) }
    return new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => {
        if (which === 'out') live.seen_out += chunk.length
        else live.seen_err += chunk.length
        for (const listener of this.outputListeners) {
          try { listener(live.xid, which === 'out' ? 'stdout' : 'stderr', chunk) } catch { /* a listener's fault never stops the log */ }
        }
        if (fd === null) return
        if (written < cap) {
          const take = chunk.length <= cap - written ? chunk : chunk.subarray(0, cap - written)
          try {
            this.logWrite(fd, take)
            written += take.length
            if (take.length < chunk.length) lose('cap')
          } catch (error) {
            lost(error)
            try { closeSync(fd) } catch { /* closed */ }
            fd = null
          }
        } else {
          lose('cap')
        }
        if (which === 'out') live.bytes_out = written
        else live.bytes_err = written
      })
      const end = () => { if (fd !== null) { try { closeSync(fd) } catch { /* closed */ } fd = null } resolve() }
      stream.on('end', end)
      stream.on('error', end)
      stream.on('close', end)
    })
  }

  /** What each stream wrote and what its log kept, and why not all of it (the record of `output`). */
  private outputRecord(live: Live): Record<string, unknown> {
    return {
      stdout: { total_bytes: live.seen_out, kept_bytes: live.bytes_out, loss: live.loss_out },
      stderr: { total_bytes: live.seen_err, kept_bytes: live.bytes_err, loss: live.loss_err },
      cap_bytes: live.spec.output_cap_bytes, complete: live.loss_out === null && live.loss_err === null,
    }
  }

  private async watch(live: Live, pumps: Promise<void>[]): Promise<void> {
    const proc = live.proc
    // no deadline unless one was given (Full access sets none of its own): the command runs until it ends or is stopped
    const deadline = live.spec.timeout_s === null ? Number.POSITIVE_INFINITY : live.started + live.spec.timeout_s
    let timedOut = false
    let cancelled = false
    let exitCode: number | null = null
    const exited = new Promise<void>((resolve) => {
      proc.once('exit', (code, signal) => {
        // a signal death reads as the negative signal number, as the first backend recorded it
        exitCode = code ?? (signal ? -(signals[signal] ?? 9) : null)
        live.exited = true
        // it waits for the lineage tick no more (its last readings are its own, below)
        this.leaveLineageTick(live)
        resolve()
      })
    })
    for (;;) {
      // its exit, or the next lineage tick: one reading of the table shared with every running command that waits for it
      const woke = await Promise.race([exited.then(() => null), this.nextLineageTick(live)])
      // its process exited: its descendants read once more, from a table made now
      if (woke === null) { this.trackLineage([live]); break }
      // the reading made on its behalf failed: this watch fails, as it did when it read alone
      if (woke.failed) throw woke.error
      if (monotonic() > deadline) timedOut = true
      else if (live.cancel_requested) cancelled = true
      else continue
      // the table was read just now, by this tick: an intermediate still alive is known before the kill
      killGroup(proc)
      await exited
      break
    }
    if (live.cancel_requested && !timedOut) cancelled = true // stop() killed the group before the poll saw it
    // the command's process is gone: what it left running goes with it, before the execution is recorded as ended
    const reaped = await this.reapStrays(live)
    live.reaped = reaped.clean
    if (!reaped.clean) console.error(`[processes] ${live.xid}: something it left was still found after ${STRAY_ROUNDS} rounds; its scratch is kept`)
    const strays = reaped.killed
    if (strays > 0) repo.noteExecutionStrays(this.conn, live.xid, strays)
    this.forks.unwatch(live.xid)
    this.forkWatched.delete(live.xid)
    if (live.profile !== null) { try { unlinkSync(live.profile) } catch { /* gone */ } }
    // let the pumps drain
    await Promise.race([Promise.all(pumps), new Promise((r) => setTimeout(r, 1000))])
    const durationMs = Math.trunc((monotonic() - live.started) * 1000)
    const status = cancelled ? 'cancelled' : timedOut ? 'timeout' : exitCode === 0 ? 'succeeded' : 'failed'
    const stdoutId = await this.seal(live, live.stdout_path, 'stdout')
    const stderrId = await this.seal(live, live.stderr_path, 'stderr')
    // a shim that found its cache cold said so: the tool is warmed on the host, so the next command is quiet
    const misses = xcrunCacheMisses(this.readOutput(live.xid, 'stderr', 0, 8192).text)
    if (misses.length && live.access === 'sandbox') void this.xcrun.warm(misses, live.home).catch(() => [])
    repo.noteExecutionOutput(this.conn, live.xid, this.outputRecord(live))
    repo.finishExecution(this.conn, live.xid, {
      status, exit_code: exitCode, timed_out: timedOut, cancelled, truncated: live.truncated, stdout_asset_id: stdoutId, stderr_asset_id: stderrId,
      stdout_bytes: live.bytes_out, stderr_bytes: live.bytes_err, duration_ms: durationMs,
    })
    live.finished = true
    // its processes are gone, its logs sealed and its end recorded: what was its alone goes, before a waiter hears it
    this.retire(live)
    live.finish()
    for (const listener of this.endListeners) {
      try { listener(live.xid) } catch { /* a listener's fault never stops the record */ }
    }
  }

  /** A command that ended, let go: its scratch removed (only once its own process and whatever it left are known to
   *  be gone) and its entry dropped from the live ones. What stays is what is meant to: its record, its log files and
   *  sealed assets (readOutput and summary read those), the workspace's HOME and temporary folder. */
  private retire(live: Live): void {
    if (!live.exited) return
    if (live.scratch !== null && live.reaped) this.removeScratch(live.scratch)
    if (this.live.get(live.xid) === live) this.live.delete(live.xid)
  }

  /** A command's scratch folder removed: only a folder this manager made (x-… directly in the scratch directory);
   *  a link left at its path is unlinked, never followed (a link inside it is removed as a link). */
  private removeScratch(scratch: string): void {
    if (dirname(scratch) !== this.settings.scratch_dir || !basename(scratch).startsWith('x-')) return
    try {
      const entry = lstatSync(scratch, { throwIfNoEntry: false })
      if (entry === undefined) return
      if (!entry.isDirectory()) unlinkSync(scratch)
      else rmSync(scratch, { recursive: true, force: true })
    } catch (error) {
      console.error(`[processes] its scratch ${scratch} could not be removed (${errorText(error)})`)
    }
  }

  /** A finished stream's log kept as an asset: a small one from memory, a larger one streamed into the store (its
   *  bytes never held whole); null when there is none or it could not be kept (said, the command's record goes on). */
  private async seal(live: Live, path: string, stream: string): Promise<string | null> {
    let size: number
    try { size = statSync(path).size } catch { return null }
    if (!size) return null
    const opts = { ext: 'log', meta: { execution_id: live.xid, stream, truncated: live.truncated, run_id: live.spec.run_id ?? null } }
    try {
      const asset = size <= SEAL_IN_MEMORY_BYTES
        ? this.store.save(this.conn, live.spec.project_id, 'log', Buffer.from(readAll(path)), opts)
        : await this.store.saveFile(this.conn, live.spec.project_id, 'log', path, opts)
      return asset.id
    } catch (error) {
      console.error(`[processes] ${live.xid}: its ${stream} log could not be kept (${errorText(error)})`)
      return null
    }
  }

  // -- control --------------------------------------------------------------

  async wait(xid: string, timeoutS: number | null): Promise<Execution | null> {
    if (this.isRemoteExecution(xid)) {
      if (this.remoteDriver?.has(xid)) return this.remoteDriver.wait(xid, timeoutS)
      if (!this.isRunning(xid)) return repo.getExecution(this.conn, xid)
      if (timeoutS === null) return new Promise<Execution | null>(() => {}) // unknown stays pinned
      await sleep(Math.max(0, timeoutS) * 1000)
      return null
    }
    const live = this.live.get(xid)
    if (live && !live.finished) {
      if (timeoutS === null) await live.done
      else await Promise.race([live.done, new Promise((r) => setTimeout(r, timeoutS * 1000))])
    }
    return repo.getExecution(this.conn, xid)
  }

  /** Stop a command: its process group, and what it left (once the process is gone). A lost execution — its
   *  command started by an earlier life of the harness — is stopped by what its record says; whether anything was. */
  stop(xid: string): boolean {
    if (this.isRemoteExecution(xid)) {
      if (!this.remoteDriver?.has(xid) || !this.remoteDriver.pending(xid)) return false
      void this.remoteDriver.stop(xid).catch(() => {}) // accepted request only; remote terminal remains separate
      return true
    }
    const live = this.live.get(xid)
    if (live === undefined) return repo.getExecution(this.conn, xid)?.status === 'lost' && this.reapLost([xid]) > 0
    if (live.exited) return false
    live.cancel_requested = true
    killGroup(live.proc)
    return true
  }

  stopAllForRun(runId: string): number {
    let count = 0
    if (!this.preserveRemoteOnShutdown) for (const execution of repo.listExecutions(this.conn, { run_id: runId })) if (this.isRemoteExecution(execution.id) && this.stop(execution.id)) count++
    // a process of the run still being made is stopped as soon as it exists (start)
    for (const pending of this.starting.values()) if (pending.run_id === runId && !(this.preserveRemoteOnShutdown && pending.workspace_id && repo.getWorkspace(this.conn, pending.workspace_id)?.target?.kind === 'ssh')) pending.stop_requested = true
    for (const live of this.live.values()) {
      if (live.spec.run_id === runId && !live.exited) {
        this.stop(live.xid)
        count += 1
      }
    }
    return count
  }

  async waitAllForRun(runId: string, timeoutS: number): Promise<void> {
    for (const live of [...this.live.values()]) {
      if (live.spec.run_id === runId) await Promise.race([live.done, new Promise((r) => setTimeout(r, timeoutS * 1000))])
    }
  }

  async shutdown(): Promise<void> {
    this.preserveRemoteOnShutdown = true
    await this.remoteDriver?.close()
    for (const live of this.live.values()) if (!live.exited) this.stop(live.xid)
    for (const live of [...this.live.values()]) await Promise.race([live.done, new Promise((r) => setTimeout(r, 5000))])
    await this.forks.close()
    dropSnapshot(this.loginSnapshot)
    this.loginSnapshot = null
  }

  isRunning(xid: string): boolean {
    if (this.isRemoteExecution(xid)) {
      if (this.remoteDriver?.has(xid)) return this.remoteDriver.pending(xid)
      const execution = repo.getExecution(this.conn, xid)
      return !execution || !['succeeded', 'failed', 'timeout', 'cancelled'].includes(execution.status)
    }
    const live = this.live.get(xid)
    return live !== undefined && !live.exited
  }

  // -- reading --------------------------------------------------------------

  /** What a stream wrote and what its log kept, and why not all of it: from the live command, else from the record
   *  (an execution recorded before this was kept: what its log holds, and `total_bytes` unknown when it was cut). */
  private streamOutput(xid: string, stream: string, kept: number, execution: Execution): { total_bytes: number | null; kept_bytes: number; loss: OutputLoss | null } {
    const live = this.live.get(xid)
    if (live !== undefined && !live.finished) {
      return stream === 'stderr' ? { total_bytes: live.seen_err, kept_bytes: kept, loss: live.loss_err } : { total_bytes: live.seen_out, kept_bytes: kept, loss: live.loss_out }
    }
    const recorded = ((execution.isolation as { output?: Record<string, { total_bytes?: unknown; loss?: unknown }> }).output ?? {})[stream === 'stderr' ? 'stderr' : 'stdout']
    if (recorded && typeof recorded.total_bytes === 'number') {
      return { total_bytes: recorded.total_bytes, kept_bytes: kept, loss: recorded.loss === 'cap' || recorded.loss === 'log_write_failed' ? recorded.loss : null }
    }
    return { total_bytes: execution.truncated ? null : kept, kept_bytes: kept, loss: execution.truncated ? 'cap' : null }
  }

  /** A window of a process's output, live or sealed: bytes from `offset`, at most `limit` (and at most 1 MiB, read as
   *  a page from the log or the sealed asset, never the whole of it), with the total so far and whether the process
   *  still runs; and what the command wrote to the stream against what was kept (`command_total_bytes`,
   *  `dropped_bytes`: a cap or a failed log write; null when an older record cannot say). */
  readOutput(xid: string, stream = 'stdout', offset = 0, limit = 16384): OutputWindow & { total_bytes: number } {
    if (this.isRemoteExecution(xid)) throw new RemoteRefused('remote_async_required', 'Remote output requires the asynchronous remote reader; local fallback refused.')
    const execution = repo.getExecution(this.conn, xid)
    if (execution === null) throw new Error(`unknown execution ${xid}`)
    const path = join(this.logs_dir, `${xid}.${stream}`)
    let data: Buffer = Buffer.alloc(0)
    // up to three bytes before the page: the start of a character the page completes
    let before: Buffer = Buffer.alloc(0)
    let total = 0
    const start = Math.max(0, offset)
    const back = Math.min(3, start)
    const want = Math.max(0, Math.min(limit, 1024 * 1024))
    if (existsSync(path)) {
      const fd = openSync(path, 'r')
      try {
        total = fstatSync(fd).size
        const from = Math.min(start, total)
        const behind = Math.min(back, from)
        const size = Math.max(0, Math.min(want, total - from))
        const buffer = Buffer.alloc(behind + size)
        let got = 0
        while (got < buffer.length) {
          const n = readSync(fd, buffer, got, buffer.length - got, from - behind + got)
          if (n <= 0) break
          got += n
        }
        before = buffer.subarray(0, Math.min(behind, got))
        data = buffer.subarray(behind, Math.max(behind, got))
      } finally {
        closeSync(fd)
      }
    } else {
      const assetId = stream === 'stdout' ? execution.stdout_asset_id : execution.stderr_asset_id
      if (assetId) {
        const asset = repo.getAsset(this.conn, assetId)
        if (asset) {
          const from = Math.max(0, start - back)
          const page = this.store.readRange(asset.storage_path, from, want + (start - from))
          total = page.total
          const behind = Math.max(0, Math.min(start, total) - from)
          before = page.bytes.subarray(0, Math.min(behind, page.bytes.length))
          data = page.bytes.subarray(Math.min(behind, page.bytes.length))
        }
      }
    }
    const running = this.isRunning(xid)
    const text = pageText(before, data, offset + data.length >= total && !running)
    const kept = this.streamOutput(xid, stream, total, execution)
    const window: OutputWindow & { total_bytes: number; command_total_bytes: number | null; dropped_bytes: number | null } = {
      execution_id: xid, stream, offset, returned_bytes: data.length, total_bytes: total, next_offset: offset + data.length,
      eof: offset + data.length >= total && !running, running, status: execution.status,
      exit_code: execution.exit_code, truncated_at_cap: execution.truncated, text,
      command_total_bytes: kept.total_bytes, dropped_bytes: kept.total_bytes === null ? null : Math.max(0, kept.total_bytes - total),
    }
    return window
  }

  /** The bounded view the model gets: the structured fields plus a head and a tail of each stream, and the pointer to
   *  read the rest; where the command ran and why (the access record), what held it, why it stopped, and — when a cap
   *  or a failed log write kept less than it wrote — how much was kept of how much, never "the whole output". */
  summary(xid: string): Record<string, unknown> {
    const execution = repo.getExecution(this.conn, xid)
    if (execution === null) throw new Error(`unknown execution ${xid}`)
    if (this.isRemoteExecution(xid)) {
      const row = this.conn.get('SELECT * FROM remote_jobs WHERE execution_id=?', [xid])!
      return { ...execution, execution_id: xid, running: this.isRunning(xid), status: this.isRunning(xid) ? 'unknown' : execution.status,
        target: { kind: 'ssh', target_id: row.target_id }, target_id: row.target_id, root_id: row.root_id, generation: row.generation, connection_state: this.remoteConnected(xid) ? 'connected' : 'disconnected',
        stdout: '', stderr: '', output_complete: false, note: 'Remote output is read asynchronously from the recorded SSH job.' }
    }
    const running = this.isRunning(xid)
    const failed = !running && commandFailed(execution)
    const out = this.shown(xid, 'stdout', failed)
    const err = this.shown(xid, 'stderr', failed)
    const isolation = execution.isolation as {
      enforcement?: string; stray_processes_killed?: number; requested_access?: string; effective_access?: string; access_reasons?: unknown[]; restrictions?: Record<string, unknown> | null
      timeout_s?: number | null; timeout_source?: string | null; output_cap_bytes?: number | null; access_mode?: string
    }
    const strays = Number(isolation.stray_processes_killed ?? 0) || 0
    const stdoutKept = execution.stdout_bytes || out.total
    const stderrKept = execution.stderr_bytes || err.total
    const stdout = this.streamOutput(xid, 'stdout', running ? out.total : stdoutKept, execution)
    const stderr = this.streamOutput(xid, 'stderr', running ? err.total : stderrKept, execution)
    const complete = stdout.loss === null && stderr.loss === null
    const cap = isolation.output_cap_bytes !== undefined ? isolation.output_cap_bytes : (isolation.restrictions?.output_cap_bytes as number | null | undefined) ?? null
    const lossNote = complete ? null : `Output not kept in full: ${[['stdout', stdout], ['stderr', stderr] as const].filter(([, o]) => (o as typeof stdout).loss !== null).map(([name, o]) => {
      const s = o as typeof stdout
      const why = s.loss === 'cap' ? `the output cap of ${(cap ?? 0).toLocaleString('en-US')} bytes` : 'its log could not be written'
      return `${name} kept the first ${s.kept_bytes.toLocaleString('en-US')} of ${s.total_bytes === null ? 'an unrecorded number of' : s.total_bytes.toLocaleString('en-US')} bytes written (${why}); the rest was not kept`
    }).join('; ')}. bash_output(execution_id, stream, offset) reads what was kept.`
    const preview = out.shown === 'preview' || err.shown === 'preview'
    const previewNote = preview ? `Output too large (${sizeText(out.shown === 'preview' ? out.total : err.total)}). ${complete ? 'The whole output is kept: bash_output(execution_id, stream, offset) reads it.' : ''} Preview (first ${PREVIEW_CHARS.toLocaleString('en-US')} characters) above.`.replace('  ', ' ') : null
    const timeout = isolation.timeout_s ?? null
    const source = isolation.timeout_source ?? (timeout === null ? null : 'default')
    const stopReason = execution.timed_out
      ? { code: 'timeout', detail: `It ran past its deadline of ${timeout ?? '?'} s (${source === 'call' ? 'set by this call' : source === 'config' ? 'the configured command limit' : source === 'check' ? 'the check\'s configured limit' : 'the sandbox\'s default limit'}): its process group was killed (SIGKILL) and what it left running was stopped.` }
      : execution.cancelled ? { code: 'stopped', detail: 'It was stopped (stop_command, its run stopped, or the harness shut down): its process group was killed (SIGKILL) and what it left running was stopped.' }
      : execution.status === 'lost' ? { code: 'lost', detail: 'The harness restarted while it ran; what it left running was stopped at the next start, its end is not known.' }
      : running ? null : limitStop(execution.exit_code, err.text, (isolation.restrictions?.resource_limits ?? null) as ResourceLimits | null)
    const access = (isolation.effective_access ?? isolation.access_mode ?? null) as string | null
    return {
      execution_id: xid, status: execution.status, exit_code: execution.exit_code, timed_out: execution.timed_out, cancelled: execution.cancelled,
      running, duration_ms: execution.duration_ms, stdout_bytes: stdoutKept, stderr_bytes: stderrKept,
      stdout_total_bytes: stdout.total_bytes, stderr_total_bytes: stderr.total_bytes, output_cap_bytes: cap, output_complete: complete,
      truncated_at_cap: execution.truncated, stdout: out.text, stdout_shown: out.shown, stderr: err.text, stderr_shown: err.shown,
      stdout_log_asset: execution.stdout_asset_id, stderr_log_asset: execution.stderr_asset_id, network: execution.network,
      isolation: isolation.enforcement ?? null,
      requested_access: isolation.requested_access ?? access, effective_access: access, access_reasons: isolation.access_reasons ?? [],
      restrictions: isolation.restrictions ?? null, timeout_s: timeout, stop_reason: stopReason,
      stray_processes_killed: strays,
      note: [lossNote, previewNote].filter(Boolean).join(' ') || (running ? 'still running: bash_output(execution_id, stream, offset) reads what it prints next' : null),
      ...(strays > 0 ? { cleanup: `${strays} process(es) the command left running were stopped with it` } : {}),
    }
  }

  /** What the model is shown of a stream (INLINE_CHARS and the rest above): the whole of it, a preview, or a failure's
   *  excerpt; `total` is the stream's size in bytes. */
  private shown(xid: string, stream: string, failed: boolean): { text: string; total: number; shown: 'whole' | 'preview' | 'excerpt' } {
    const path = join(this.logs_dir, `${xid}.${stream}`)
    if (!existsSync(path)) return { text: '', total: 0, shown: 'whole' }
    const fd = openSync(path, 'r')
    try {
      const total = fstatSync(fd).size
      // a character is at most 4 bytes: this many bytes hold the first INLINE_CHARS + 1 characters, whatever they are
      const want = Math.min(total, (INLINE_CHARS + 1) * 4)
      const read = Buffer.alloc(want)
      readSync(fd, read, 0, want, 0)
      const decoded = read.subarray(0, want === total ? want : characterEnd(read)).toString('utf8')
      if (decoded.length <= INLINE_CHARS && want === total) return { text: decoded, total, shown: 'whole' }
      const window = decoded.slice(0, INLINE_CHARS)
      if (!failed) return { text: window.slice(0, PREVIEW_CHARS), total, shown: 'preview' }
      const half = FAILURE_EXCERPT_CHARS / 2
      return { text: `${window.slice(0, half)}\n…[middle elided]…\n${window.slice(-half)}`, total, shown: 'excerpt' }
    } finally {
      closeSync(fd)
    }
  }
}

/** Whether a finished command failed as Claude Code counts it: a non-zero exit (or none: stopped, timed out), but an
 *  exit of 1 from a command that uses it for "nothing found" or "differs". */
function commandFailed(execution: { exit_code: number | null; status: string; command: string }): boolean {
  if (execution.exit_code === 0) return false
  if (execution.exit_code === 1) {
    const words = execution.command.trim().split(/\s+/)
    const name = words[0] === 'git' ? `git ${words[1] ?? ''}` : words[0] ?? ''
    if (BENIGN_EXIT_1.includes(name)) return false
  }
  return true
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`
}

/** How many of the bytes end on a character boundary: the whole, less a last character whose bytes go on past it. */
function characterEnd(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back += 1) {
    const b = bytes[bytes.length - back]!
    if ((b & 0xc0) === 0x80) continue
    const length = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    return length > back ? bytes.length - back : bytes.length
  }
  return bytes.length
}

function readAll(path: string): Uint8Array {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(size)
    let got = 0
    while (got < size) {
      const n = readSync(fd, buffer, got, size - got, got)
      if (n <= 0) break
      got += n
    }
    return buffer.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

function killGroup(proc: ChildProcess): void {
  if (proc.pid === undefined) return
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }
}

/** An error as a log line says it: its code when it has one (ENOSPC), and its message. */
function errorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' && !message.includes(code) ? `${code}: ${message}` : message
}
