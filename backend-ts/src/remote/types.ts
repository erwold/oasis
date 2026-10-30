export interface SshTargetConfig { destination: string; port?: number | null; identity_file?: string | null }
export interface RetryPolicy { attempts: number; base_delay_ms: number; max_delay_ms: number; budget_ms: number }
export interface TransportOptions {
  /** Explicit ssh_config (isolated test sshd only). Default is `-F /dev/null`: the person's config is never read. */
  config_file?: string; known_hosts_file?: string; ssh_path?: string; python?: string;
  /** The app's own known_hosts (host keys the person trusted in the app), read after the person's own files; unused
   *  when `known_hosts_file` (an isolated test sshd's) is given. */
  app_known_hosts_file?: string;
  rpc_timeout_ms?: number; control_directory?: string;
  /** Bounded exponential backoff + jitter for transport failures of reads/probe/channel establishment. */
  retry?: Partial<RetryPolicy>;
  /** A mutation is written only if the channel answered within this window; otherwise a probe ping goes first. */
  idle_ping_ms?: number;
  /** Read batches allowed in flight at once on the one channel (mutations are always alone). */
  max_pipeline?: number;
}
/** The only root fields a request uses; a persisted binding can be passed as-is. */
export type RootRef = Pick<RemoteRoot, 'path' | 'state_path' | 'root_id' | 'generation'>
export interface RequestOptions { signal?: AbortSignal }
export interface TransportStats {
  challenges: number; channels_opened: number; channel_failures: number; requests: number; retries: number; pings: number;
  disconnected: boolean; last_failure: string | null;
  channel: { pid: number | null; opened_at: string; batches: number; idle_ms: number } | null;
}
export interface RemoteCapabilities {
  direct_files: boolean; durable_jobs: boolean; journal_undo: boolean; port_forwarding: boolean;
  sandbox: false; restricted_shell: false; snapshots: false; isolated_copies: false;
}
export interface ProbeResult { protocol: 1; python_version: string; platform: string; exec: true; capabilities: RemoteCapabilities }
export interface RemoteRoot {
  path: string; state_path: string; root_id: string; generation: string;
  capabilities: RemoteCapabilities; limits: { small_file_bytes: number; page_bytes: number; frame_bytes: number };
}
export interface LeaseProof { lease_id: string; owner_id: string; fence: number }
export interface Lease extends LeaseProof { updated_at: string }
export interface FileStat { path: string; kind: 'file' | 'directory' | 'symlink' | 'other'; size: number; mode: number; sha256?: string }
export interface DirectoryPage { path: string; entries: FileStat[]; next_offset: number | null; truncated: boolean; fingerprint: string }
export interface BytePage { data: string; byte_offset: number; next_offset: number; eof: boolean; sha256?: string; total_written: number; total_retained: number; gaps: Array<{start: number; end: number}>; storage_failed?: boolean; log_complete?: boolean }
export interface TailPage {
  file_id: string; size: number; mtime_ms: number; data: string; byte_offset: number; next_offset: number; eof: boolean;
  head: string; anchor: string | null; crc: number | null;
  /** with verify: where the CRC stopped (it covers [crc_from, crc_next)); byte_offset when it is whole */
  crc_next: number | null;
}
export interface WriteReceipt { path: string; operation_id: string; before: string | null; after: string | null; before_sha256: string | null; after_sha256: string | null; state: 'applied' }
export interface RemoteJob {
  job_id: string; operation_id: string; state: 'starting' | 'running' | 'exited' | 'unknown';
  pid_identity?: { pid: number; identity: string }; exit_code?: number | null; signal?: number | null;
  ended_at?: string; reason?: string; stdout_bytes?: number; stderr_bytes?: number; log_complete?: boolean; terminal_confirmed?: boolean;
  timeout_s: number | null; output_cap_bytes: number | null;
}
export interface OperationStatus { operation_id: string; state: 'not_found' | 'prepared' | 'applied' | 'unknown' | 'failed'; result?: WriteReceipt | RemoteJob | Lease | null; code?: string }
export interface PolicyScope {
  path: string; device: number; inode: number; case_sensitive: boolean | null;
  unicode: 'byte-exact' | 'opaque'; source: 'darwin-fpathconf' | 'linux-inode-flags' | 'unknown';
}
/** Deny/constraint matching only: conservative positives MUST NOT authorize allowlists. */
export interface PolicyMatchResult {
  path: string; absolute_path: string; exists: boolean; matches: boolean[]; matched_patterns: string[];
  conservative: boolean; scopes: PolicyScope[];
}
export interface MethodParams {
  'roots.validate': Record<string, never>;
  'files.resolve': {path: string; allow_missing?: boolean};
  'files.policyMatch': {path: string; patterns: string[]; allow_missing?: boolean};
  'files.stat': {path: string};
  'files.read': {path: string; byte_offset?: number; limit?: number; expected_hash?: string};
  /** Read-only, for a file that grows (a chart's source): a page from byte_offset read up to the size the file had when
   *  the request began, the file's first and the anchor_bytes before byte_offset, its identity and modification time, and
   *  with verify the CRC-32 of [crc_from, byte_offset) continued from crc_seed, a bounded slice per request (crc_next) —
   *  no whole-file hash per page (files.read's expected_hash). */
  'files.tail': {path: string; byte_offset: number; limit: number; anchor_bytes: number; verify: boolean; crc_from?: number; crc_seed?: number};
  'files.list': {path: string; offset?: number; limit?: number; fingerprint?: string};
  'files.search': {path: string; query: string; byte_offset?: number; limit?: number; expected_hash?: string};
  'files.write': {path: string; expected_hash: string | null; data: string; lease: LeaseProof};
  'files.edit': {path: string; expected_hash: string; old_string: string; new_string: string; replace_all?: boolean; lease: LeaseProof};
  'files.remove': {path: string; expected_hash: string; lease: LeaseProof};
  'operations.status': {operation_id: string};
  'jobs.start': {command: string; cwd?: string; shell?: string; env?: Record<string,string>; timeout_s?: number | null; output_cap_bytes?: number | null; lease: LeaseProof};
  'jobs.status': {job_id: string};
  'jobs.recover': {operation_id: string};
  'jobs.read': {job_id: string; stream: 'stdout' | 'stderr'; byte_offset?: number; limit?: number};
  'jobs.stop': {job_id: string; signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT'};
  'leases.acquire': {owner_id: string};
  'leases.inspect': Record<string, never>;
  'leases.renew': {lease: LeaseProof};
  'leases.release': {lease: LeaseProof};
}
export interface MethodResults {
  'files.policyMatch': PolicyMatchResult;
  'files.resolve': {path: string; absolute_path: string; exists: boolean; kind?: FileStat['kind']};
  'roots.validate': RemoteRoot; 'files.stat': FileStat; 'files.read': BytePage; 'files.tail': TailPage; 'files.list': DirectoryPage;
  'files.search': {matches: number[]; next_offset: number; eof: boolean; sha256: string; incomplete: boolean};
  'files.write': WriteReceipt; 'files.edit': WriteReceipt; 'files.remove': WriteReceipt;
  'operations.status': OperationStatus; 'jobs.start': RemoteJob; 'jobs.status': RemoteJob;
  'jobs.recover': RemoteJob; 'jobs.read': BytePage;
  'jobs.stop': {job_id: string; state: 'requested' | 'terminal-confirmed'; job: RemoteJob};
  'leases.acquire': Lease; 'leases.inspect': Lease | null; 'leases.renew': Lease; 'leases.release': {released: boolean};
}
export type RemoteMethod = keyof MethodParams;
export interface OwnedForward { id: string; remote_host: '127.0.0.1'; remote_port: number; local_host: '127.0.0.1'; local_port: number; local_url: string; state: 'ready' | 'disconnected' | 'error' }
/** delivery (transport errors only): 'not_sent' = no byte of the request reached ssh, so a mutation
 * certainly did not run; 'unknown' = it was sent and no definite answer arrived (outcome_unknown). */
export class RemoteError extends Error {
  constructor(public code: string, message: string, public status: 'refused' | 'conflict' | 'disconnected' | 'unknown' = 'refused', public retryable = false, public operation_id?: string, public delivery?: 'not_sent' | 'unknown') { super(message); this.name = 'RemoteError' }
}
