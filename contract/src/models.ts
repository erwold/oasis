/** The vocabulary shared by the database, the API and the agent: one zod schema per row model, with the same
 *  field names, defaults and nullability the rows carry. `z.infer` of a schema is the type the frontend reads. */

import { z } from 'zod'
import { RunCollabSchema } from './collab_core.ts'
import { ACCESS_MODES } from './modes.ts'
import { TargetRefSchema, RemoteWorkspaceBindingSchema, RemoteExecutionRefSchema, RemoteConnectionStateSchema } from './remote.ts'

export const RunStatusSchema = z.enum(['queued', 'running', 'done', 'cancelled', 'error'])
export type RunStatus = z.infer<typeof RunStatusSchema>
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running']

/** ChatGPT on the web: the person's own ChatGPT page in the desktop app, a participant of plain conversation (its runs
 *  type into the page through the app's bridge; no tool of the harness, words only in). */
export const CHATGPT_WEB_ID = 'chatgpt:web'

/** Remote observation states are not completion: only the durable driver finalizes a row after trustworthy exit and drained logs. */
export const ExecutionStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'timeout', 'cancelled', 'lost', 'starting', 'unknown', 'exited'])
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>
/** What the side effect did: applied (it ran to an exit code), not_applied (never started), unknown (interrupted). */
export const EffectStateSchema = z.enum(['not_started', 'applied', 'not_applied', 'unknown'])
export type EffectState = z.infer<typeof EffectStateSchema>
export const CheckStatusSchema = z.enum(['pass', 'fail', 'unknown', 'not_applicable'])
export type CheckStatus = z.infer<typeof CheckStatusSchema>
export const CostStatusSchema = z.enum(['reported', 'estimated', 'unknown'])
export type CostStatus = z.infer<typeof CostStatusSchema>

const JsonRecord = z.record(z.string(), z.unknown())

/** How a project holds its folder: `snapshot` — the folder's files (or a repository's HEAD) copied into a base
 *  repository at import, the workspaces branch from it; `attached` — nothing copied: the folder is read as it stands
 *  and never written, and a session's workspace is a scratch of its own with the folder mounted read-only inside it. */
/** snapshot: the folder copied into a base repository, each session on a worktree of it; attached: read as it
 *  stands, never copied, never written; direct (schema v19, the default for a folder opened since): edited in place,
 *  no copy and no repository of the harness's — every file-tool write kept first in the journal, so a run's file
 *  changes can be undone. */
export const ProjectKindSchema = z.enum(['snapshot', 'attached', 'direct'])
export type ProjectKind = z.infer<typeof ProjectKindSchema>

export const ProjectSchema = z.object({
  target: TargetRefSchema.optional(),
  remote: RemoteWorkspaceBindingSchema.nullable().optional(),
  id: z.string(),
  name: z.string(),
  kind: ProjectKindSchema.default('snapshot'),
  source_path: z.string().nullable(),
  base_repo_path: z.string(),
  base_commit: z.string().nullable(),
  base_branch: z.string().nullable(),
  import_report: JsonRecord.default({}),
  default_model: z.string().nullable().default(null),
  config: JsonRecord.default({}),
  created_at: z.string(),
  updated_at: z.string(),
  /** schema v27: the latest activity of its sessions (deleted ones aside), else when it was made — the rail's order;
   *  absent from a harness before v27 */
  last_activity_at: z.string().optional(),
})
export type Project = z.infer<typeof ProjectSchema>

/** What a session is allowed to do without a per-call approval. The defaults are the ordinary development grant:
 *  read and write the task workspace, run commands in it, reach the network, write an attached folder. */
export const GrantsSchema = z.object({
  workspace_write: z.boolean().default(true),
  run_commands: z.boolean().default(true),
  // an attached project only: may runs write the attached folder itself (never undone by a checkpoint; each patch
  // and command is recorded). On by default; Plan turns it off.
  attached_write: z.boolean().default(true),
  network: z.boolean().default(true),
  network_until: z.string().nullable().default(null),
  network_reason: z.string().nullable().default(null),
})
export type Grants = z.infer<typeof GrantsSchema>

export const SessionTitleSourceSchema = z.enum(['auto', 'director', 'person'])
export type SessionTitleSource = z.infer<typeof SessionTitleSourceSchema>
/** How long a session title a director gives may be (the rail and the header show a line). */
export const MAX_DIRECTED_TITLE = 60

/** What a session root grants: reading only, or reading and writing. */
export const ROOT_ACCESS = ['read', 'write'] as const
export type RootAccess = (typeof ROOT_ACCESS)[number]
/** schema v29: a folder a session reaches besides its working folder — its real absolute path and its access. */
export const SessionRootSchema = z.object({ path: z.string(), access: z.enum(ROOT_ACCESS) })
export type SessionRoot = z.infer<typeof SessionRootSchema>

export const SessionSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  /** who named the session: auto (the start screen, from the first words), director (its plan's title), person */
  title_source: SessionTitleSourceSchema.default('auto'),
  workspace_id: z.string().nullable(),
  model: z.string(),
  grants: GrantsSchema.default(() => GrantsSchema.parse({})),
  /** schema v28: where its commands run (modes.ts ACCESS_MODES); absent from an older answer: the sandbox, as it ran */
  access_mode: z.enum(ACCESS_MODES).default('sandbox'),
  /** schema v29: the task the session belongs to, by its first session's id (null: the session is its own task's
   *  first — every session from before v29). Sessions of one task may be in different projects. The harness always
   *  answers it; absent from an older answer (read as null) */
  task_root_id: z.string().nullable().optional(),
  /** schema v29: folders besides its working folder the session reaches by absolute path, each read-only or writable
   *  (SessionRootSchema); sorted by path. The harness always answers it; absent from an older answer (read as none) */
  roots: z.array(SessionRootSchema).optional(),
  /** schema v36: stable append order in the pinned rail; absent on older backends means unpinned. */
  pin_order: z.number().int().positive().nullable().optional(),
  status: z.string().default('open'),
  created_at: z.string(),
  /** when the row last changed (a rename, a setting, a run's record): not the session's activity */
  updated_at: z.string(),
  /** schema v27: the latest activity in it — a run started or finished, words sent, a call to its director — never a
   *  rename, a setting or what a restart's recovery wrote; the rail's order. Absent from a harness before v26. */
  last_activity_at: z.string().optional(),
})
export type Session = z.infer<typeof SessionSchema>

/** One exchange of a conversation held outside this program (ChatGPT as the director, through the director
 *  endpoint), mirrored into the session's thread as it was: the person's question, the director's answer. */
export const DirectorNoteSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  source: z.string(),
  model: z.string().default(''),
  question: z.string().default(''),
  answer: z.string(),
  /** the director turn this note closed (schema v8), when the harness held the conversation; null for a note the
   *  director mirrored on its own */
  turn_id: z.string().nullable().default(null),
  created_at: z.string(),
})
export type DirectorNote = z.infer<typeof DirectorNoteSchema>

/** direct: the person's own folder, the one workspace of every session of a direct project (branch and base commit
 *  empty: there is no repository of the harness's); never removed by the harness. */
export const WorkspaceKindSchema = z.enum(['task', 'child', 'verify', 'integration', 'direct'])
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>

export const SourceMountSchema = z.object({ root: z.string(), name: z.string(), readonly: z.literal(true) })
export type SourceMount = z.infer<typeof SourceMountSchema>

export const WorkspaceSchema = z.object({
  target: TargetRefSchema.optional(),
  remote: RemoteWorkspaceBindingSchema.nullable().optional(),
  /** A live read-only source, not an immutable snapshot. Never widened by attached_write. */
  source_mount: SourceMountSchema.nullable().default(null),
  id: z.string(),
  project_id: z.string(),
  session_id: z.string().nullable(),
  path: z.string(),
  branch: z.string(),
  base_commit: z.string(),
  // task: a session's own worktree; child: a child run's worktree from a base checkpoint; verify: a detached
  // checkout for checks; integration: where chosen checkpoints are composed onto a fixed base
  kind: z.string().default('task'),
  created_at: z.string(),
})
export type Workspace = z.infer<typeof WorkspaceSchema>

/** Hard limits the mechanism enforces (a dollar figure is never a hard guarantee without a reliable price, so the
 *  enforceable ones are requests, tokens, tool calls and time). */
export const BudgetSchema = z.object({
  requests: z.number().int().min(1).nullable().optional(),
  total_tokens: z.number().int().min(1).nullable().optional(),
  wall_clock_s: z.number().int().min(1).nullable().optional(),
  tool_calls: z.number().int().min(1).nullable().optional(),
})
export type Budget = z.infer<typeof BudgetSchema>

/** An image the person attached to a message: stored by the harness as an asset of the session (never a path or a
 *  URL the client chose), described by what the server measured. The message history keeps this reference only; the
 *  bytes are read at the provider boundary for each request. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const ImageAttachmentSchema = z.object({
  asset_id: z.string(),
  media_type: z.enum(IMAGE_MEDIA_TYPES),
  bytes: z.number().int(),
  sha256: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  name: z.string(),
})
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>

/** New references only. Old ImageAttachment JSON is neither wrapped nor rewritten. */
export const FileAttachmentSchema = z.object({
  asset_id: z.string(), media_type: z.enum(['text/plain', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime']),
  bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(),
  file_kind: z.enum(['text', 'pdf', 'video']), representation: z.enum(['utf8-v1', 'native-v1']),
}).refine((a) => a.file_kind === 'text' ? a.media_type === 'text/plain' && a.representation === 'utf8-v1'
  : a.representation === 'native-v1' && (a.file_kind === 'pdf' ? a.media_type === 'application/pdf' : a.media_type.startsWith('video/')))
export type FileAttachment = z.infer<typeof FileAttachmentSchema>

/** A PDF or a video kept by reference (docs/large-file-attachments.md): the history holds these frozen fields only,
 *  never the bytes, and never a rewrite of them. `location` is the absolute real path fixed when the reference was
 *  made — the person's own file for `local` (registered by the desktop app: nothing copied, nothing hashed), the
 *  harness's stored upload for `upload` (written once, hashed as it streamed). `sha256` is a hash of the content or
 *  null: an upload always has one, a local file never does (a hash of the path is not a content hash). No size limit
 *  here: whether the bytes travel to a model is decided per request from these fields and the route (refNativeFor). */
export const REF_REPRESENTATION = 'ref-v1' as const
export const FileRefAttachmentSchema = z.object({
  asset_id: z.string(),
  name: z.string(),
  media_type: z.string().regex(/^(application\/pdf|video\/[a-z0-9][a-z0-9.+-]*)$/),
  bytes: z.number().int().nonnegative(),
  file_kind: z.enum(['pdf', 'video']),
  representation: z.literal(REF_REPRESENTATION),
  origin: z.enum(['local', 'upload']),
  location: z.string().min(2).refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'location is an absolute path'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).refine((a) => (a.file_kind === 'pdf' ? a.media_type === 'application/pdf' : a.media_type.startsWith('video/'))
  && (a.origin === 'local' ? a.sha256 === null : a.sha256 !== null), 'file_kind/media_type, or origin/sha256, disagree')
export type FileRefAttachment = z.infer<typeof FileRefAttachmentSchema>

/** What the asset row of a local reference keeps beside the frozen fields (Asset.meta.fingerprint): the identity of
 *  the file when it was registered, read by the harness itself with lstat/stat on the real path — never taken from a
 *  client. Decimal strings (an inode or a nanosecond time can pass 2^53). A native read of a local file opens it and
 *  compares this with fstat on the open descriptor; any difference refuses — changed bytes never silently stand in. */
export const FileFingerprintSchema = z.object({
  dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), size: z.string().regex(/^\d+$/),
  mtime_ns: z.string().regex(/^\d+$/), ctime_ns: z.string().regex(/^\d+$/),
})
export type FileFingerprint = z.infer<typeof FileFingerprintSchema>
/** Asset.kind of a reference's row (storage_path '' and sha256 '' for a local file; an upload's store-relative path
 *  and its content hash). */
export const REF_ASSET_KIND = 'file_ref'

// The three never parse each other's objects (their media types and representations differ); old JSON parses as before.
export const AttachmentSchema = z.union([ImageAttachmentSchema, FileAttachmentSchema, FileRefAttachmentSchema])
export type Attachment = z.infer<typeof AttachmentSchema>
export function isFileRefAttachment(a: unknown): a is FileRefAttachment {
  return typeof a === 'object' && a !== null && (a as { representation?: unknown }).representation === REF_REPRESENTATION
}


export const RunSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  project_id: z.string(),
  workspace_id: z.string().nullable(),
  parent_run_id: z.string().nullable().default(null),
  resumes_run_id: z.string().nullable().default(null),
  spawned_by: z.string().default('human'),
  label: z.string().nullable().default(null),
  model: z.string(),
  model_config_snapshot: JsonRecord.default({}),
  user_text: z.string(),
  status: RunStatusSchema,
  usage: JsonRecord.default({}),
  manifest: JsonRecord.default({}),
  budget: BudgetSchema.default({}),
  error: z.string().nullable().default(null),
  created_at: z.string(),
  finished_at: z.string().nullable().default(null),
  saved_seq: z.number().int().default(0),
  // the summary the runner assembled at the end (the mechanical side measured; the model's own words as final_text)
  receipt: JsonRecord.default({}),
  // the work order this run works under (null for a session thread's own runs)
  work_order: JsonRecord.nullable().default(null),
  // the images the person attached to this run's message (schema v7)
  attachments: z.array(AttachmentSchema).default([]),
  // the relay this run is a turn of, and which turn (schema v13); null for a run of its own
  relay_id: z.string().nullable().default(null),
  relay_step: z.number().int().nullable().default(null),
  // the interaction this run is a node of, and which node (schema v15); null for a run of its own
  interaction_id: z.string().nullable().default(null),
  interaction_node: z.string().nullable().default(null),
  // who the run belongs to, why it started and where it is shown (schema v25, contract/src/collab_core.ts): recorded
  // for a run started by a v25 backend, projected for an older row; absent from an older backend's answers
  collab: RunCollabSchema.nullable().optional(),
})
export type Run = z.infer<typeof RunSchema>

/** Who starts a run of the session's own conversation: the person, or a watch the conversation's agent set (the
 *  harness wakes it: schema v18). */
/** Who starts a thread's runs: the person, a watch of the conversation, or an MCP client through the connector (ChatGPT,
 *  say — the run's label names it). */
export const THREAD_SPAWNERS = ['human', 'wake', 'connector'] as const
export const CONNECTOR_SPAWNER = 'connector'

/** A run of the session's own conversation: the person started it (or a watch its agent set woke it), under no order.
 *  The pre-v25 reading, kept as it was for older rows and older clients: it cannot tell a participant's follow-up (no
 *  order, no interaction id) from the thread's own run, nor who started a run from where it is shown. From schema v25
 *  `run.collab` says both (collaboration.ts: runSurface, isMainThreadRun); read that where it is present. */
export function isThreadRun(run: Pick<Run, 'parent_run_id' | 'work_order' | 'spawned_by'>): boolean {
  return run.parent_run_id === null && run.work_order === null && (THREAD_SPAWNERS as readonly string[]).includes(run.spawned_by)
}

export const ExecutionSchema = z.object({
  target: TargetRefSchema.optional(),
  remote: RemoteExecutionRefSchema.nullable().optional(),
  connection_state: RemoteConnectionStateSchema.optional(),
  remote_status: z.enum(['starting', 'running', 'exited', 'unknown']).optional(),
  id: z.string(),
  run_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  kind: z.string(),
  command: z.string(),
  cwd: z.string(),
  status: ExecutionStatusSchema,
  effect_state: EffectStateSchema,
  exit_code: z.number().int().nullable().default(null),
  timed_out: z.boolean().default(false),
  cancelled: z.boolean().default(false),
  truncated: z.boolean().default(false),
  stdout_asset_id: z.string().nullable().default(null),
  stderr_asset_id: z.string().nullable().default(null),
  stdout_bytes: z.number().int().default(0),
  stderr_bytes: z.number().int().default(0),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  duration_ms: z.number().int().nullable().default(null),
  isolation: JsonRecord.default({}),
  network: z.boolean().default(false),
  created_at: z.string(),
})
export type Execution = z.infer<typeof ExecutionSchema>

/** A WorkspaceSnapshot: the base commit plus a tree of what the working files actually held (tracked and
 *  untracked, ignore rules honoured), so a HEAD that did not move still has an exact, referable state. */
export const SnapshotSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  base_commit: z.string(),
  tree_sha: z.string(),
  file_count: z.number().int(),
  untracked: z.array(z.string()).default([]),
  excluded_rules: z.array(z.string()).default([]),
  changed_paths: z.array(z.string()).default([]),
  created_at: z.string(),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

export const CheckpointSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  run_id: z.string().nullable(),
  snapshot_id: z.string(),
  commit_sha: z.string(),
  ref: z.string(),
  parent_checkpoint_id: z.string().nullable(),
  note: z.string(),
  created_at: z.string(),
  /** the git repositories inside the workspace its tree leaves out (each a repository of its own; workspace-relative
   *  paths, from its snapshot's excluded rules): a copy made from it does not contain them. Absent from an older answer */
  excluded_nested_repositories: z.array(z.string()).optional(),
})
export type Checkpoint = z.infer<typeof CheckpointSchema>

export const CheckResultSchema = z.object({
  id: z.string(),
  run_id: z.string().nullable(),
  workspace_id: z.string(),
  snapshot_id: z.string(),
  check_id: z.string(),
  command: z.string(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  log_asset_id: z.string().nullable(),
  parser: z.string(),
  parser_version: z.string(),
  counts: z.record(z.string(), z.number()).default({}),
  status: CheckStatusSchema,
  reason: z.string().default(''),
  created_at: z.string(),
})
export type CheckResult = z.infer<typeof CheckResultSchema>

export const AssetSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  kind: z.string(),
  sha256: z.string(),
  byte_size: z.number().int(),
  storage_path: z.string(),
  meta: JsonRecord.default({}),
  created_at: z.string(),
})
export type Asset = z.infer<typeof AssetSchema>

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'consumed'])
export const ApprovalSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  run_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  action: z.string(),
  params: JsonRecord.default({}),
  params_sha256: z.string(),
  status: ApprovalStatusSchema,
  created_at: z.string(),
  decided_at: z.string().nullable().default(null),
})
export type Approval = z.infer<typeof ApprovalSchema>

export const ModelRequestRecordSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  seq: z.number().int(),
  model_id: z.string(),
  configured_model: z.string(),
  provider_reported_model: z.string().nullable(),
  endpoint: z.string(),
  started_at: z.string(),
  latency_ms: z.number().int().nullable(),
  input_tokens: z.number().int().default(0),
  output_tokens: z.number().int().default(0),
  cache_read_tokens: z.number().int().default(0),
  cache_write_tokens: z.number().int().default(0),
  cost_usd: z.number().nullable().default(null),
  /** Standard BigModel API estimate in CNY; null/absent is not zero USD. */
  cost_cny: z.number().nullable().optional(),
  cost_status: CostStatusSchema.default('unknown'),
  cost_source: z.string().nullable().default(null),
  status: z.string().default('ok'),
  error: z.string().nullable().default(null),
  tool_schema_sha256: z.string().nullable().default(null),
  message_count: z.number().int().default(0),
  context_estimate_tokens: z.number().int().nullable().default(null),
})
export type ModelRequestRecord = z.infer<typeof ModelRequestRecordSchema>

/** A price list entry the operator supplied; cost estimates cite it. Absent: cost is unknown, never 0. */
export const PricingSchema = z.object({
  /** Omitted on historical lists: USD. Never convert CNY into cost_usd without an exchange-rate source. */
  currency: z.enum(['USD', 'CNY']).optional(),
  /** Listed rates are off-peak; weekday peak periods may be Chinese public holidays. */
  schedule: z.enum(['deepseek-peak']).optional(),
  input_per_mtok: z.number(),
  output_per_mtok: z.number(),
  cache_read_per_mtok: z.number().nullable().default(null),
  cache_write_per_mtok: z.number().nullable().default(null),
  // a write into an hour-long cache entry (Anthropic: twice the input rate; the 5-minute write is cache_write_per_mtok)
  cache_write_1h_per_mtok: z.number().nullable().default(null),
  /** Per server-tool request, in this price list's currency. Omitted means unknown, not free. */
  web_search_per_request: z.number().nonnegative().optional(),
  source: z.string().min(1),
  version: z.string().min(1),
  /** Optional whole-request tariff above an inclusive prompt threshold; equality uses base rates.
   * input_tokens already includes cache reads/writes. No marginal or retrospective pricing. */
  long_context: z.object({
    above_input_tokens: z.number().int().nonnegative(),
    input_per_mtok: z.number().nonnegative(),
    output_per_mtok: z.number().nonnegative(),
    cache_read_per_mtok: z.number().nonnegative(),
    cache_write_per_mtok: z.number().nonnegative(),
    cache_write_1h_per_mtok: z.number().nonnegative(),
  }).optional(),
  /** a published change: from that day (UTC) on, a request is priced at these rates instead */
  next: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    input_per_mtok: z.number(),
    output_per_mtok: z.number(),
    cache_read_per_mtok: z.number().nullable().default(null),
    cache_write_per_mtok: z.number().nullable().default(null),
    version: z.string().min(1),
  }).nullable().default(null),
})
export type Pricing = z.infer<typeof PricingSchema>

/** A verification command the project declares (run in a clean verification worktree at the delivery snapshot). */
export const CheckConfigSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  // omitted (null): no deadline of the check's own — a Full access check runs until it ends (or is stopped), a
  // sandboxed one under the sandbox's default limit (backend execution/processes.ts SANDBOX_DEFAULT_TIMEOUT_S)
  timeout_s: z.number().int().nullable().default(null),
  parser: z.enum(['pytest', 'node_test', 'exit_code']).default('exit_code'),
  required: z.boolean().default(true),
})
export type CheckConfig = z.infer<typeof CheckConfigSchema>
