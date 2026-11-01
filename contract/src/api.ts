/** The REST surface: every route the backend serves, the bodies it accepts and the shapes it answers with. The
 *  bodies are validated by the backend with these schemas; the responses are typed for the frontend and the
 *  director. */

import { z } from 'zod'
import { TargetRefSchema, RemoteExecutionRefSchema, RemoteConnectionStateSchema } from './remote.ts'
import {
  ApprovalSchema, BudgetSchema, CheckConfigSchema, CheckResultSchema, CheckpointSchema, DirectorNoteSchema,
  ExecutionSchema, GrantsSchema, ModelRequestRecordSchema, ProjectSchema, RunSchema, RunStatusSchema, SessionSchema,
  SnapshotSchema, WorkspaceSchema, SessionRootSchema, ROOT_ACCESS,
} from './models.ts'
import { AttributionFieldsSchema, LockSpecSchema, ReceiptSchema, WorkOrderShapeSchema } from './work_orders.ts'
import { ReplayEventSchema } from './events.ts'
import { ACCESS_MODES, HARNESS_MODES } from './modes.ts'
import { DirectorSessionSchema } from './director.ts'
import { MAX_RELAY_PARTICIPANTS, MAX_RELAY_ROUNDS, RelaySchema } from './relay.ts'
import { InteractionDetailSchema } from './interaction.ts'
import { WakeEventSchema, WatchSchema } from './watches.ts'
import { UiSurfaceRecordSchema, type UiSurfaceRecord } from './ui.ts'
import { UiInputRecordSchema, type UiInputRecord } from './ui_interaction.ts'
import { ActiveRunSchema, CitationsSchema, ReceiveRunIdsSchema, RunCollabSchema } from './collab_core.ts'

// ---- the route table ---------------------------------------------------------------------------------------------

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; public?: boolean; note?: string
  /** answered only under the `x-oasis-code-token` header: the session cookie alone is refused (the desktop app's main
   *  process, never the page) */
  token_header_only?: boolean
}

/** Every route under API_VERSION (the code-v1 surface), with the session's mode and attachments and the director
 *  session added compatibly.
 *  `public` routes need no session token (the handshake and the cookie login). */
export const ROUTES: readonly Route[] = [
  // meta
  { method: 'GET', path: '/api/meta/build', public: true, note: 'the build handshake' },
  { method: 'GET', path: '/api/auth/session', public: true, note: 'the cookie login (?token=)' },
  { method: 'GET', path: '/api/models' },
  { method: 'GET', path: '/api/meta/isolation' },
  { method: 'GET', path: '/api/agent/surface' },
  // projects
  { method: 'GET', path: '/api/projects' },
  { method: 'POST', path: '/api/projects' },
  { method: 'GET', path: '/api/projects/:project_id' },
  { method: 'PUT', path: '/api/projects/:project_id/config' },
  { method: 'POST', path: '/api/projects/:project_id/config/additions' },
  // sessions
  { method: 'POST', path: '/api/projects/:project_id/sessions' },
  { method: 'GET', path: '/api/session-activity', note: "every session's agents now and how many ended (the rail's dots)" },
  { method: 'GET', path: '/api/sessions/:session_id' },
  { method: 'PUT', path: '/api/sessions/:session_id', note: 'rename it' },
  { method: 'PUT', path: '/api/sessions/:session_id/pin', note: 'pin or unpin it without changing its activity or timestamps' },
  { method: 'DELETE', path: '/api/sessions/:session_id', note: 'delete it: gone from the lists and the API; its records and worktree stay on disk' },
  { method: 'GET', path: '/api/sessions/:session_id/runs/tree' },
  { method: 'GET', path: '/api/sessions/:session_id/context' },
  { method: 'GET', path: '/api/sessions/:session_id/replay' },
  { method: 'POST', path: '/api/sessions/:session_id/share-snapshot', note: 'the offline share projection of a quiescent session (ShareSnapshotRequest → ShareSnapshotResponse; contract/src/share.ts); 409 session_active while work is under way' },
  { method: 'POST', path: '/api/sessions/:session_id/director-notes' },
  { method: 'GET', path: '/api/sessions/:session_id/director-notes' },
  { method: 'POST', path: '/api/sessions/:session_id/work-orders' },
  { method: 'PUT', path: '/api/sessions/:session_id/grants' },
  { method: 'GET', path: '/api/sessions/:session_id/mode', note: 'the permission preset (auto | approve | plan | custom)' },
  { method: 'PUT', path: '/api/sessions/:session_id/mode' },
  { method: 'GET', path: '/api/sessions/:session_id/access', note: 'where its commands run (full | sandbox) and whether it can be changed now (SessionAccess)' },
  { method: 'PUT', path: '/api/sessions/:session_id/access', note: 'change it (AccessBody → SessionAccess); 409 while a run, a command or an approval of the session is outstanding' },
  { method: 'POST', path: '/api/sessions/:session_id/attachments', note: 'raw bytes (?name=): a bounded image or UTF-8 text/code; a PDF or video streams into a ref-v1 upload (one request stays under the server body bound — larger files use the chunked upload)' },
  { method: 'GET', path: '/api/sessions/:session_id/attachments/:asset_id', note: "validated attachment bytes, this session's only; non-images download (a ref-v1 upload streams with byte ranges; a local ref-v1 is never served)" },
  // PDF / video references (docs/large-file-attachments.md): the desktop app's local registration, the chunked upload
  { method: 'POST', path: '/api/sessions/:session_id/attachments/local', token_header_only: true, note: 'a PDF or video on this machine, by its absolute path (LocalAttachmentBody): nothing copied or hashed; the desktop app\'s main process only' },
  { method: 'POST', path: '/api/sessions/:session_id/uploads', note: 'start a chunked upload of a PDF or video (UploadStartBody → UploadStart)' },
  { method: 'GET', path: '/api/sessions/:session_id/uploads/:upload_id', note: 'how much of it arrived (UploadStatus): resume from there; a completed upload says completed for a while; not kept across a restart of the harness' },
  { method: 'PUT', path: '/api/sessions/:session_id/uploads/:upload_id', note: 'the next chunk, raw bytes at ?offset= (exactly what arrived so far), at most chunk_bytes (→ UploadReceived)' },
  { method: 'POST', path: '/api/sessions/:session_id/uploads/:upload_id/complete', note: 'all size bytes arrived: the reference (→ Attachment); asked again for a while after, the same reference (nothing new stored)' },
  { method: 'DELETE', path: '/api/sessions/:session_id/uploads/:upload_id', note: 'drop it and what arrived (a chunk being written is stopped first); a completed upload is not undone (409)' },
  { method: 'PUT', path: '/api/sessions/:session_id/model' },
  // Intelligent UI (contract/src/ui.ts): the surfaces the session's agents presented, the person's values, the actions
  { method: 'GET', path: '/api/sessions/:session_id/ui', note: "every surface of the session's runs, the latest revision of each" },
  { method: 'PUT', path: '/api/sessions/:session_id/ui/:run_id/:surface_id/state', note: "the person's values (409 on another revision)" },
  { method: 'POST', path: '/api/sessions/:session_id/ui/:run_id/:surface_id/actions', note: 'an action prepared as a prompt for the draft: nothing is run or sent' },
  // Intelligent UI interaction (contract/src/ui_interaction.ts): agent tasks started from a surface; request_input's forms
  { method: 'POST', path: '/api/sessions/:session_id/ui/:run_id/:surface_id/tasks', note: "a `run` action's agent task, started (or queued behind the conversation's live run)" },
  { method: 'GET', path: '/api/sessions/:session_id/ui-tasks', note: 'the tasks, newest first (?run_id=&surface_id=&active=1)' },
  { method: 'GET', path: '/api/sessions/:session_id/ui-tasks/:task_id' },
  { method: 'POST', path: '/api/sessions/:session_id/ui-tasks/:task_id/cancel', note: 'stop it: a queued one ends now, a running one with its run' },
  { method: 'GET', path: '/api/sessions/:session_id/ui-inputs', note: "request_input's forms, newest first (?run_id=&status=pending)" },
  { method: 'GET', path: '/api/sessions/:session_id/ui-inputs/:input_id' },
  { method: 'POST', path: '/api/sessions/:session_id/ui-inputs/:input_id/submit', note: "the person's values: the waiting call's result" },
  { method: 'POST', path: '/api/sessions/:session_id/ui-inputs/:input_id/dismiss', note: 'the person declines: the waiting call answers dismissed' },
  { method: 'POST', path: '/api/approvals/:approval_id' },
  // runs
  { method: 'POST', path: '/api/sessions/:session_id/chat' },
  { method: 'GET', path: '/api/runs/:run_id' },
  { method: 'GET', path: '/api/runs/:run_id/receipt' },
  { method: 'GET', path: '/api/runs/:run_id/calls/:tool_call_id', note: 'one tool call as its model saw it: the arguments and the whole return (long texts cut past a bound)' },
  { method: 'GET', path: '/api/runs/:run_id/diff', note: "the patch its receipt measured (?path= one file; ?full=1 each file whole)" },
  { method: 'GET', path: '/api/runs/:run_id/transcript' },
  { method: 'GET', path: '/api/runs/:run_id/events', note: 'SSE with a cursor (Last-Event-ID or ?after=)' },
  { method: 'POST', path: '/api/runs/:run_id/cancel' },
  { method: 'POST', path: '/api/runs/:run_id/steer', note: "the person's words to a live thread run, handed at its next model request (contract/src/steering.ts)" },
  { method: 'GET', path: '/api/runs/:run_id/steers', note: 'the steers of a run, by queued_seq' },
  { method: 'POST', path: '/api/runs/:run_id/resume', note: 'a follow-up of an ended run: the Run it started (200), or QueuedFollowup (202) for a group member\'s step queued behind its group' },
  // the collaboration model (schema v25, collaboration.ts: COLLABORATION_ROUTES are these four)
  { method: 'GET', path: '/api/sessions/:session_id/collaboration', note: 'the session\'s participants, conversations, groups, runs, planned steps, typed edges and thread summaries (?if_revision= answers 304 while unchanged)' },
  { method: 'GET', path: '/api/runs/:run_id/collaboration', note: "one run's participant, conversation and edges in and out" },
  { method: 'GET', path: '/api/participants/:participant_id', note: 'a participant, its conversations, its runs (?limit=&before=) and edges' },
  { method: 'POST', path: '/api/participants/:participant_id/messages', note: 'a message continuing the participant\'s current conversation (ParticipantMessageBody → Run, or QueuedFollowup with 202)' },
  // the relay (schema v13): one message to several agents who take turns on it
  { method: 'GET', path: '/api/sessions/:session_id/relays' },
  { method: 'GET', path: '/api/relays/:relay_id' },
  { method: 'POST', path: '/api/relays/:relay_id/cancel', note: 'stop the whole chain: the live turn is cancelled, no later turn starts' },
  { method: 'POST', path: '/api/relays/:relay_id/continue', note: 'resume a waiting or interrupted relay, or give a finished one more rounds' },
  // the interaction (schema v15): one message to several agents run as a graph of nodes the harness schedules
  { method: 'POST', path: '/api/sessions/:session_id/interactions', note: "start one: a template's plan, a fixed graph, or the director's (asked)" },
  { method: 'GET', path: '/api/sessions/:session_id/interactions' },
  { method: 'GET', path: '/api/interactions/:interaction_id' },
  { method: 'POST', path: '/api/interactions/:interaction_id/schedule', note: "the plan, or more of it (the director's tool)" },
  { method: 'POST', path: '/api/interactions/:interaction_id/steps', note: 'steps the person asks for (another round, a synthesis); the budget grows to fit them' },
  { method: 'POST', path: '/api/interactions/:interaction_id/cancel', note: 'stop the whole interaction: live runs are cancelled, nothing starts after' },
  { method: 'POST', path: '/api/interactions/:interaction_id/continue', note: 'resume a waiting or interrupted interaction' },
  { method: 'POST', path: '/api/interactions/:interaction_id/pause', note: 'let the running steps end, start nothing new; continue goes on' },
  { method: 'POST', path: '/api/interactions/:interaction_id/notes', note: "the person's words to everyone or one participant, handed at its next run" },
  { method: 'POST', path: '/api/interactions/:interaction_id/adopt', note: "a node's final state composed into the session's working folder" },
  // workspaces
  { method: 'GET', path: '/api/workspaces/:workspace_id' },
  { method: 'GET', path: '/api/workspaces/:workspace_id/entities' },
  { method: 'GET', path: '/api/workspaces/:workspace_id/files' },
  { method: 'GET', path: '/api/workspaces/:workspace_id/file' },
  { method: 'GET', path: '/api/workspaces/:workspace_id/diff', note: 'the changes against the base (?path= one file; ?full=1 each file whole)' },
  { method: 'POST', path: '/api/workspaces/:workspace_id/checkpoint' },
  { method: 'POST', path: '/api/workspaces/:workspace_id/verify' },
  { method: 'POST', path: '/api/workspaces/:workspace_id/integrate' },
  { method: 'GET', path: '/api/executions/:execution_id' },
  { method: 'GET', path: '/api/executions/:execution_id/output' },
  { method: 'POST', path: '/api/executions/:execution_id/stop' },
  { method: 'GET', path: '/api/assets/:asset_id', note: 'text/plain' },
  // the gate
  { method: 'GET', path: '/api/sessions/:session_id/agent-control' },
  { method: 'POST', path: '/api/sessions/:session_id/agent-control' },
  { method: 'GET', path: '/api/sessions/:session_id/action-proposals' },
  { method: 'GET', path: '/api/action-proposals/:proposal_id' },
  { method: 'POST', path: '/api/action-proposals/:proposal_id/decide' },
  { method: 'GET', path: '/api/sessions/:session_id/locks' },
  { method: 'PUT', path: '/api/sessions/:session_id/locks' },
  // the folder browser
  { method: 'GET', path: '/api/fs/dirs' },
  // accounts (writes answer only the machine the backend runs on)
  { method: 'GET', path: '/api/auth/accounts' },
  { method: 'GET', path: '/api/auth/usage' },
  { method: 'PUT', path: '/api/auth/keys/:provider' },
  { method: 'DELETE', path: '/api/auth/keys/:provider' },
  { method: 'POST', path: '/api/auth/login/:provider' },
  { method: 'GET', path: '/api/auth/login/:login_id' },
  { method: 'POST', path: '/api/auth/login/:login_id/code' },
  { method: 'DELETE', path: '/api/auth/login/:login_id' },
  { method: 'DELETE', path: '/api/auth/accounts/:provider' },
  // the director session (schema v8): the harness holds the conversation with an outside director and continues it
  { method: 'GET', path: '/api/sessions/:session_id/director', note: 'the director session, its turns, the pending task events, the transports' },
  { method: 'POST', path: '/api/sessions/:session_id/director', note: 'open one (native | bridge)' },
  { method: 'PUT', path: '/api/sessions/:session_id/director', note: 'pause / resume, the model, the config' },
  { method: 'DELETE', path: '/api/sessions/:session_id/director', note: 'close it' },
  { method: 'POST', path: '/api/sessions/:session_id/director/messages', note: "the person's message to the director: a turn" },
  { method: 'GET', path: '/api/director/waiting', note: 'the sessions a director turn waits on now' },
  { method: 'GET', path: '/api/director-turns/:turn_id' },
  { method: 'GET', path: '/api/director-turns/:turn_id/events', note: 'SSE: the turn as it streams' },
  { method: 'POST', path: '/api/director-turns/:turn_id/cancel' },
  { method: 'POST', path: '/api/runs/:run_id/director-ack', note: "the director read this run's receipt itself: its task event needs no turn" },
]

// ---- request bodies ------------------------------------------------------------------------------------------------

/** A root as a request names it: an absolute path (resolved to its real path when registered) and its access. */
export const SessionRootInputSchema = z.object({ path: z.string().min(1).max(4096), access: z.enum(ROOT_ACCESS) }).strict()

export const ImportBodySchema = z.object({
  target: TargetRefSchema.optional(),
  remote_state_path: z.string().startsWith('/').max(4096).optional(),
  name: z.string().nullable().optional(),
  source_path: z.string().nullable().optional(),
  default_model: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  // snapshot (the default of the API): the folder copied into a base repository; attached: read as it stands, never
  // copied; direct: edited in place (the page's choice for a folder)
  mode: z.enum(['snapshot', 'attached', 'direct']).nullable().optional(),
  // the client's key: the same key again answers with the project it made (or waits for the import under way)
  client_request_id: z.string().min(8).max(100).nullable().optional(),
  // a task that needs no folder: the one project for them (made the first time, the same one after); each session
  // in it still gets a working folder of its own to write in
  no_folder: z.boolean().optional(),
  // with source_path: make the folder first — its last component only, inside a parent that exists (never recursive)
  create_directory: z.boolean().optional(),
  // with source_path, a local Git repository: a new worktree of it on a new branch, opened in direct mode
  worktree: z.object({
    branch: z.string().min(1).max(200),
    base: z.string().min(1).max(200).nullable().optional(),
    folder: z.string().startsWith('/').max(4096).nullable().optional(),
  }).nullable().optional(),
})
export type ImportBody = z.infer<typeof ImportBodySchema>

/** The name of the project that holds the tasks started without a folder. */
export const NO_FOLDER_PROJECT = 'No folder'

/** A snapshot import refused because the folder is too big to copy (HTTP 413): what was measured (stopped at the
 *  first limit crossed, so `bytes` and `files` are lower bounds), the limits, and the ways out. */
export const ImportRefusalSchema = z.object({
  detail: z.string(),
  refusal: z.literal('snapshot_too_large'),
  source_path: z.string(),
  measured: z.object({ bytes: z.number(), files: z.number(), stopped_early: z.boolean(), seconds: z.number() }),
  limits: z.object({ max_bytes: z.number(), max_files: z.number() }),
  options: z.array(z.enum(['attached', 'subfolder'])),
})
export type ImportRefusal = z.infer<typeof ImportRefusalSchema>

export const ProjectConfigBodySchema = z.object({
  instructions: z.string().nullable().optional(),
  protected_paths: z.array(z.string()).nullable().optional(),
  checks: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  default_model: z.string().nullable().optional(),
})
export type ProjectConfigBody = z.infer<typeof ProjectConfigBodySchema>

export const SessionBodySchema = z.object({
  title: z.string().default('New task'),
  model: z.string().nullable().optional(),
  // the permission preset the session starts in, set with the session in one transaction (omitted: the default
  // grants, which are Auto's)
  mode: z.enum(HARNESS_MODES).nullable().optional(),
  // where its commands run (omitted: DEFAULT_ACCESS_MODE, full)
  access_mode: z.enum(ACCESS_MODES).nullable().optional(),
  // the client's key: the same key again in the project answers with the session it made
  client_request_id: z.string().min(8).max(100).nullable().optional(),
  // schema v29: the session whose task the new one joins (its task_root_id becomes that task's first session)
  task_session_id: z.string().min(1).nullable().optional(),
  // schema v29: folders besides the working folder, each read-only or writable (validated: api/roots.ts)
  roots: z.array(SessionRootInputSchema).nullable().optional(),
})
export type SessionBody = z.infer<typeof SessionBodySchema>

/** schema v29: a session's roots, replaced whole (PUT /api/sessions/:id/roots). */
export const RootsBodySchema = z.object({ roots: z.array(SessionRootInputSchema) }).strict()
export type RootsBody = z.infer<typeof RootsBodySchema>
/** A session's roots as GET/PUT /api/sessions/:id/roots answers them. */
export const SessionRootsSchema = z.object({
  session_id: z.string(),
  roots: z.array(SessionRootSchema.extend({ created_at: z.string() })),
  changeable: z.boolean(),
  blocked_by: z.object({ runs: z.number().int(), executions: z.number().int(), approvals: z.number().int() }),
})
export type SessionRoots = z.infer<typeof SessionRootsSchema>

export const SessionUpdateBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
})
export type SessionUpdateBody = z.infer<typeof SessionUpdateBodySchema>

export const SessionPinBodySchema = z.object({ pinned: z.boolean() }).strict()
export type SessionPinBody = z.infer<typeof SessionPinBodySchema>

/** How hard the model thinks on a run: the unified level ("off" disables it; omitted = the provider's default). */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export const MentionSchema = z.object({
  path: z.string().min(1).max(500),
  symbol: z.string().max(200).nullable().optional(),
})
export type Mention = z.infer<typeof MentionSchema>

/** How many attachments one message may carry. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8

// ---- PDF / video references: the desktop app's local registration and the chunked upload -----------------------
// (docs/large-file-attachments.md). Both answer one `Attachment` — a FileRefAttachment (`ref-v1`) — and a message
// names it by asset id like any other attachment.

/** The routes of the references, as ROUTES lists them. */
export const REF_ATTACHMENT_ROUTES: readonly Route[] = ROUTES.filter((r) => r.path.endsWith('/attachments/local') || r.path.includes('/uploads'))

/** The size of one upload chunk: the transport's unit (it keeps every request under the server's body bound), not a
 *  limit on the file. */
export const UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024

/** A local file to reference: its absolute path as the operating system gave it for a file the person chose, dropped
 *  or pasted (Electron webUtils.getPathForFile). The harness resolves and checks it itself (a regular file, a PDF or
 *  video by name and a bounded head, not where the agent's commands are denied); `name` is only the label shown,
 *  `media_type` only a hint. A refusal is final: the client does not fall back to uploading the file. */
export const LocalAttachmentBodySchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().max(1024).nullable().optional(),
  media_type: z.string().max(127).nullable().optional(),
})
export type LocalAttachmentBody = z.infer<typeof LocalAttachmentBodySchema>

/** A chunked upload of a PDF or video (a file the browser holds without a path). `size` is the whole file's; no limit. */
export const UploadStartBodySchema = z.object({
  name: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  type: z.string().max(127).default(''),
})
export type UploadStartBody = z.infer<typeof UploadStartBodySchema>
export const UploadStartSchema = z.object({ upload_id: z.string(), chunk_bytes: z.number().int().positive(), received: z.literal(0) })
export type UploadStart = z.infer<typeof UploadStartSchema>
export const UploadReceivedSchema = z.object({ received: z.number().int().nonnegative() })
export type UploadReceived = z.infer<typeof UploadReceivedSchema>
/** `completed`: the upload was already made an attachment (a completion whose answer was lost); POST …/complete answers
 *  that same attachment again for a while (UPLOAD_COMPLETED_TTL_MS on the server), nothing new is stored. */
export const UploadStatusSchema = z.object({ upload_id: z.string(), received: z.number().int().nonnegative(), size: z.number().int().nonnegative(), completed: z.boolean().optional() })
export type UploadStatus = z.infer<typeof UploadStatusSchema>

export const ChatBodySchema = z.object({
  text: z.string(),
  model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  budget: BudgetSchema.nullable().optional(),
  resumes_run_id: z.string().nullable().optional(),
  // a new session-thread inside the session: no earlier history is carried
  fresh: z.boolean().default(false),
  // @-mentions the person made (a path, optionally a symbol in it): read-only pointers resolved and pinned at send
  mentions: z.array(z.record(z.string(), z.unknown())).default([]),
  // attachments uploaded to this session (POST …/attachments) that go with the message, by asset id
  attachments: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  // the client's key for this message: the same key again in the session answers with the run it started, so a
  // resend after a lost response never starts a second run
  client_request_id: z.string().min(8).max(100).nullable().optional(),
  // the agents the message names with @, in order (schema v13): one is the model of this run; two or more are a
  // relay — they take turns on the message, the first doing it, the next reviewing
  agents: z.array(z.object({ model: z.string().min(1) })).max(MAX_RELAY_PARTICIPANTS).default([]),
  // how many rounds the relay runs (a round: every agent once, in order); one by default
  rounds: z.number().int().min(1).max(MAX_RELAY_ROUNDS).default(1),
  // a participant's own thinking effort, by its id in the message (`pt_3f2a9c`: the @ menu's choice for its model);
  // a participant without one runs at `thinking`
  participant_thinking: z.record(z.string(), z.string()).default({}),
  // schema v25 (docs/multi-agent-unification-design.md): runs of the session the message refers to — recorded as cited
  // edges, named to the agent by run and participant, their content not handed over; and runs whose final answers are
  // handed over whole as packets of the opening message (received edges). Exact ended runs of this session. A
  // pre-v25 backend does not read them.
  cites: CitationsSchema.optional(),
  receive_run_ids: ReceiveRunIdsSchema.optional(),
  // schema v29: receive_run_ids may name ended runs of other sessions (asked for explicitly: director.v6); their final
  // answers are handed over with their session and run, and nothing else of those sessions comes with them
  receive_across_sessions: z.boolean().optional(),
})
export type ChatBody = z.infer<typeof ChatBodySchema>

export const WorkOrderBodySchema = z.object({
  work_order: z.record(z.string(), z.unknown()),
  thinking: z.string().nullable().optional(),
  // the client's key for this dispatch: the same key again in the session answers with the run it started
  client_request_id: z.string().min(8).max(100).nullable().optional(),
  // schema v25: isolated — the run's own workspace whatever the project's kind (a copy from a checkpoint; over a direct
  // or attached folder, an output folder of its own with the folder mounted live read-only); legacy (the default of
  // this route, as before) — a direct project's order works in the folder itself
  workspace_policy: z.enum(['legacy', 'isolated']).optional(),
  cites: CitationsSchema.optional(),
  receive_run_ids: ReceiveRunIdsSchema.optional(),
  // schema v29: receive_run_ids may name ended runs of other sessions (asked for explicitly: director.v6); their final
  // answers are handed over with their session and run, and nothing else of those sessions comes with them
  receive_across_sessions: z.boolean().optional(),
})
export type WorkOrderBody = z.infer<typeof WorkOrderBodySchema>

export const GrantsBodySchema = z.object({
  workspace_write: z.boolean().nullable().optional(),
  run_commands: z.boolean().nullable().optional(),
  attached_write: z.boolean().nullable().optional(),
  network: z.boolean().nullable().optional(),
  network_minutes: z.number().int().nullable().optional(),
  network_reason: z.string().nullable().optional(),
})
export type GrantsBody = z.infer<typeof GrantsBodySchema>

export const AccessBodySchema = z.object({ access_mode: z.enum(ACCESS_MODES) }).strict()
export type AccessBody = z.infer<typeof AccessBodySchema>
/** What keeps a session's access from changing now: its active runs, its commands still running (any workspace of
 *  the session, a child's included) and its approvals / proposed actions still waiting for a decision. */
export const AccessBlockersSchema = z.object({ runs: z.number().int(), executions: z.number().int(), approvals: z.number().int() })
export type AccessBlockers = z.infer<typeof AccessBlockersSchema>

export const ModelBodySchema = z.object({ model: z.string() })
export const DecisionBodySchema = z.object({ approve: z.boolean() })

export const ResumeBodySchema = z.object({
  text: z.string(),
  // what the follow-up narrows in the resumed run's order (a field left out is inherited; a field that would widen
  // the order is refused); omitted = the resumed run's own order, with the person's text as its prompt
  work_order: z.record(z.string(), z.unknown()).nullable().optional(),
  model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  // images uploaded to the session that go with the follow-up, by asset id
  attachments: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  // the client's key for this follow-up: the same key again on the run answers with the follow-up it started
  client_request_id: z.string().min(8).max(100).nullable().optional(),
  // schema v25: as on ChatBody; and the head the caller saw — refused (409) when the resumed run's conversation moved
  // past it meanwhile (a follow-up of an older run is a branch of its own, made only when this is not given)
  cites: CitationsSchema.optional(),
  receive_run_ids: ReceiveRunIdsSchema.optional(),
  // schema v29: receive_run_ids may name ended runs of other sessions (asked for explicitly: director.v6); their final
  // answers are handed over with their session and run, and nothing else of those sessions comes with them
  receive_across_sessions: z.boolean().optional(),
  expected_head_run_id: z.string().nullable().optional(),
})
export type ResumeBody = z.infer<typeof ResumeBodySchema>

export const CheckpointBodySchema = z.object({ note: z.string().default('checkpoint from the UI') })
export const VerifyBodySchema = z.object({ checkpoint_id: z.string().nullable().optional() })
/** POST /api/workspaces/:id/commands: a command run in the session's folder (as an agent's bash runs it: the same
 *  sandbox, grants, locks and logs), or — `execution_id` instead — one started so, waited on again. */
export const CommandBodySchema = z.object({
  command: z.string().min(1).nullable().optional(),
  execution_id: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  wait_s: z.number().int().min(0).max(600).default(30),
  timeout_s: z.number().int().min(1).nullable().optional(),
  /** where the command runs: sandbox (omitted: the route's behaviour before access modes) or the session's access
   *  (`session`: director.v6 and later) */
  access: z.enum(['sandbox', 'session']).optional(),
  /** with access `session`: the session whose access and permissions the command runs under — required when more
   *  than one session works in the folder (a folder edited in place is one workspace shared by its sessions) */
  session_id: z.string().nullable().optional(),
  /** true (director.v6, or the person's own client): the command is held to reading — the OS refuses its writes to
   *  the folder, its Git metadata and the session's roots — and runs beside the folder's writer instead of waiting
   *  for it; refused (409 restriction_unavailable) where that cannot be enforced. Omitted or false: a writer */
  read_only: z.boolean().optional(),
}).refine((b) => !!b.command !== !!b.execution_id, { message: 'send a command or an execution_id, not both' })
export const IntegrateBodySchema = z.object({
  checkpoint_ids: z.array(z.string()),
  note: z.string().default('integration from the UI'),
  verify: z.boolean().default(true),
})
export type IntegrateBody = z.infer<typeof IntegrateBodySchema>

export const ControlBodySchema = z.object({
  desired_state: z.string(),
  gate_effects: z.array(z.string()).default([]),
  run_id: z.string().nullable().optional(),
})
export const DecideBodySchema = z.object({ decision: z.string(), reason: z.string().default('') })

export const LocksBodySchema = z.object({ locks: z.array(z.record(z.string(), z.unknown())) })

export const DirectorNoteBodySchema = z.object({
  source: z.string().default('chatgpt'),
  model: z.string().default(''),
  question: z.string().default(''),
  answer: z.string(),
})
export type DirectorNoteBody = z.infer<typeof DirectorNoteBodySchema>

export const PastedRedirectSchema = z.object({ input: z.string().min(1).max(4096) })
export const PastedKeySchema = z.object({
  key: z.string().min(1).max(4096),
  label: z.string().max(200).nullable().optional(),
  env: z.string().max(200).nullable().optional(),
})

// ---- responses -----------------------------------------------------------------------------------------------------

/** What the rail reads of a session's agents without opening it (GET /api/session-activity, every session at once):
 *  facts only, never a verdict — the page reads them with its own bot rules (frontend state/presence.ts).
 *  - live: every run of the session in line or at work now (this process's), with what its own rows would say of it:
 *    a request waiting for its slot, a form of it waiting for the person;
 *  - director: the session's open director, its state and its current turn;
 *  - ended: how many of the session's agent runs (never a person's action nor a plan's placeholder) and director turns
 *    have reached an end — done, error or cancelled (a stop, an interruption, a filtered answer: every end) — so far.
 *    It only grows (an ended run or turn never lives again, none is ever removed), by one for each end, two ends in
 *    the same millisecond included: the page's "seen up to" mark compares with it.
 *  - agents: who has taken part, for the rail's bots — the main agent (once it ran), each other participant in the
 *    order it first ran (its model: ChatGPT on the web has its own mark), ChatGPT's own commands through a connector,
 *    a director. Absent from an older harness. */
export const SessionActivityAgentSchema = z.object({
  kind: z.enum(['main', 'participant', 'chatgpt', 'director']),
  participant_id: z.string().nullable(),
  model: z.string().nullable(),
})
export type SessionActivityAgent = z.infer<typeof SessionActivityAgentSchema>
export const SessionActivityRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  spawned_by: z.string(),
  model: z.string().nullable(),
  slot_waiting: z.boolean(),
  pending_input: z.boolean(),
})
export type SessionActivityRun = z.infer<typeof SessionActivityRunSchema>
export const SessionActivitySchema = z.object({
  live: z.array(SessionActivityRunSchema),
  director: z.object({
    state: z.string(),
    turn: z.object({ id: z.string(), status: z.string(), finished_at: z.string().nullable() }).nullable(),
  }).nullable(),
  ended: z.number().int().nonnegative(),
  agents: z.array(SessionActivityAgentSchema).optional(),
})
export type SessionActivity = z.infer<typeof SessionActivitySchema>
/** GET /api/session-activity: every session the lists show (none deleted), by id. */
export const SessionActivityResponseSchema = z.object({ sessions: z.record(z.string(), SessionActivitySchema) })
export type SessionActivityResponse = z.infer<typeof SessionActivityResponseSchema>

export const ProjectDetailSchema = ProjectSchema.extend({
  sessions: z.array(SessionSchema).optional(),
  workspaces: z.array(WorkspaceSchema).optional(),
})
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>

/** schema v29: a session of the same task, as a session's detail lists them (oldest first, this one included). */
export const TaskSessionSchema = z.object({ id: z.string(), project_id: z.string(), title: z.string(), status: z.string(), last_activity_at: z.string() })
export type TaskSession = z.infer<typeof TaskSessionSchema>

/** A command of this session still running (or a remote writer whose end is not known yet) after the run that
 *  started it ended: a later run of the same conversation works beside it; anything else waits for it. */
export const BackgroundCommandSchema = z.object({
  execution_id: z.string(),
  run_id: z.string().nullable(),
  workspace_id: z.string(),
  command: z.string(),
  status: z.string(),
  /** the conversation of the run that started it (null: unknown — no same-conversation run is admitted beside it) */
  conversation_id: z.string().nullable(),
})
export type BackgroundCommand = z.infer<typeof BackgroundCommandSchema>

export const SessionDetailSchema = SessionSchema.extend({
  workspace: WorkspaceSchema.nullable(),
  /** schema v29: every session of its task (task_root_id), this one included; absent from an older answer */
  task_sessions: z.array(TaskSessionSchema).optional(),
  runs: z.array(RunSchema),
  director_notes: z.array(DirectorNoteSchema),
  /** the open director session of this session, when the harness holds a conversation with a director (schema v8) */
  director: DirectorSessionSchema.nullable().optional(),
  /** steerable: the live run takes the person's words now (POST /api/runs/:run_id/steer); absent in older answers */
  active_run: z.object({ id: z.string(), status: z.string(), saved_seq: z.number().int(), steerable: z.boolean().optional() }).nullable(),
  /** the session's relays (schema v13), oldest first */
  relays: z.array(RelaySchema).default([]),
  /** the session's interactions (schema v15) with their nodes, oldest first */
  interactions: z.array(InteractionDetailSchema).default([]),
  /** the watches the session's agent set (schema v18), newest first, and what they saw */
  watches: z.array(WatchSchema).default([]),
  wake_events: z.array(WakeEventSchema).default([]),
  active_children: z.array(z.object({ id: z.string(), status: z.string(), label: z.string().nullable() })),
  // every run of the session, the thread's and the order runs beside it: a page reads the run tree again when it moves
  run_count: z.number().int(),
  pending_approvals: z.array(ApprovalSchema),
  // schema v25 (absent from an older backend): the session's main agent, every live run with its participant and
  // surface (active_run is the main agent's alone then), and the collaboration graph's revision (a page reads
  // GET /api/sessions/:id/collaboration again when it changes)
  main_participant_id: z.string().nullable().optional(),
  active_runs: z.array(ActiveRunSchema).optional(),
  collaboration_revision: z.string().nullable().optional(),
  // schema v26 (absent from an older backend): the session cursor of this answer — GET /api/sessions/:id/events?after=
  // it sends every event of each run live in this answer, and every event after it (events.ts, SESSION_STREAM_READY)
  event_cursor: z.number().int().optional(),
  /** this session's commands still running after the run that started them ended (absent from an older backend) */
  background_commands: z.array(BackgroundCommandSchema).optional(),
})
export type SessionDetail = z.infer<typeof SessionDetailSchema>
/** GET / PUT /api/sessions/:id/access: the session's access, whether it can change now (nothing of the session is
 *  outstanding) and, when it cannot, what holds it. */
export const SessionAccessSchema = z.object({
  access_mode: z.enum(ACCESS_MODES), switchable: z.boolean(), blocked_by: AccessBlockersSchema, session: SessionDetailSchema,
})
export type SessionAccess = z.infer<typeof SessionAccessSchema>

/** A run as the outline's row: parent_run_id is the tree, the rest is what a row shows. */
export const RunTreeRowSchema = z.object({
  id: z.string(), session_id: z.string(), parent_run_id: z.string().nullable(), resumes_run_id: z.string().nullable(),
  spawned_by: z.string(), label: z.string().nullable(), model: z.string().nullable(),
  /** a run's status; `waiting` only on a plan's own rows: a director asleep while its plan runs, a decision that is the person's */
  status: z.enum(['queued', 'running', 'done', 'cancelled', 'error', 'waiting']), live: z.boolean(),
  created_at: z.string(), finished_at: z.string().nullable(), workspace_id: z.string().nullable(), user_text: z.string(),
  user_text_head: z.string(), work_order: WorkOrderShapeSchema.nullable(),
  receipt: ReceiptSchema.nullable(), error: z.string().nullable(),
  usage: z.record(z.string(), z.number()), depth: z.number().int(),
  /** the relay turn this run is (schema v13), so a replay shows the turn as the thread does */
  relay_id: z.string().nullable().default(null), relay_step: z.number().int().nullable().default(null),
  /** the interaction node this run is (schema v15) */
  interaction_id: z.string().nullable().default(null), interaction_node: z.string().nullable().default(null),
  /** the plan node this row carries (a relay step, an interaction node): one row per node in the outline */
  plan_node_id: z.string().nullable().default(null),
  /** the participant: a stable instance inside the relay or interaction, never renumbered; two may run one model */
  participant_id: z.string().nullable().default(null), participant_alias: z.string().nullable().default(null),
  /** the participant's place in its relay or interaction (0-based): the bot and the name the page shows follow it */
  participant_index: z.number().int().nullable().default(null), participant_name: z.string().nullable().default(null),
  /** the rows that must end before this one starts: run ids, or plan node ids while the run does not exist yet */
  depends_on: z.array(z.string()).default([]),
  /** who scheduled the row when that is not the run's own parent: a director's plan row */
  scheduled_by: z.string().nullable().default(null),
  /** a run; a plan (the director's, its nodes hang under it); a decision that is the person's */
  kind: z.enum(['run', 'ask', 'decision', 'plan']).default('run'),
  /** schema v25: the run's participant, conversation, origin and placement (absent on a plan's own rows and from an
   *  older backend). `participant_id` above stays the plan's own key (`<group>:<alias>`); the stable participant is
   *  `collab.participant_id`. */
  collab: RunCollabSchema.nullable().optional(),
})
export type RunTreeRow = z.infer<typeof RunTreeRowSchema>

export const RunDetailResponseSchema = RunSchema.extend({
  live: z.boolean(),
  depth: z.number().int(),
  children: z.array(z.object({ id: z.string(), label: z.string().nullable(), status: RunStatusSchema, model: z.string() })),
  requests: z.array(ModelRequestRecordSchema),
  executions: z.array(ExecutionSchema),
})
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>

export const TranscriptEntrySchema = z.object({
  // ui: a surface the run presented (Intelligent UI), its latest revision, after the call that first presented it;
  // input: a form the run's request_input showed (contract/src/ui_interaction.ts), as it stands — pending, submitted,
  // dismissed or closed — right after the call that showed it (its toolCallId)
  kind: z.enum(['user', 'agent', 'activity', 'thinking', 'note', 'ui', 'input', 'compaction']),
  /** Compaction lifecycle/report from run_events, not the model's summary text. */
  compaction: z.record(z.string(), z.unknown()).optional(),
  text: z.string().optional(),
  tool: z.string().optional(),
  toolCallId: z.string().optional(),
  summary: z.string().optional(),
  args: z.record(z.string(), z.unknown()).nullable().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  running: z.boolean().optional(),
  surface: UiSurfaceRecordSchema.optional(),
  input: UiInputRecordSchema.optional(),
  /** a user entry that is a steer delivered in this run: its id, and the seq of its steer_delivered event (where it
   *  stands among the run's events) */
  steer_id: z.string().optional(),
  seq: z.number().int().optional(),
})
export type TranscriptEntry = Omit<z.infer<typeof TranscriptEntrySchema>, 'surface' | 'input'> & { surface?: UiSurfaceRecord; input?: UiInputRecord }

export const WorkspaceStatusSchema = z.object({
  modified: z.array(z.string()), added: z.array(z.string()), deleted: z.array(z.string()), untracked: z.array(z.string()),
  renamed: z.array(z.string()), base_commit: z.string().optional(), branch: z.string().optional(), path: z.string().optional(),
  external_changes: z.array(z.string()),
  /** a folder edited in place that cannot be reached where it was opened: why (its files are then unknown, not removed) */
  unreachable: z.string().optional(),
})

export const WorkspaceDetailSchema = WorkspaceSchema.extend({
  status: WorkspaceStatusSchema,
  lock_owner: z.string().nullable(),
  latest_snapshot: SnapshotSchema.nullable(),
  checkpoints: z.array(CheckpointSchema),
  executions: z.array(ExecutionSchema),
  checks: z.array(CheckResultSchema.extend({ stale: z.boolean(), tree_sha: z.string().nullable() })),
})
export type WorkspaceDetail = z.infer<typeof WorkspaceDetailSchema>

export const NumstatRowSchema = z.object({ path: z.string(), added: z.number().int().nullable(), removed: z.number().int().nullable() })
export const ReviewFlagSchema = z.object({ path: z.string(), kind: z.string(), detail: z.string() })
/** A whole diff too large to send at once: its patch holds the first `shown_files` of `total_files` files (the file
 *  list is whole); a file's own diff is asked for by its path. */
export const PatchCutSchema = z.object({ shown_files: z.number().int(), total_files: z.number().int(), chars: z.number().int() })
export type PatchCut = z.infer<typeof PatchCutSchema>
export const DiffResponseSchema = z.object({
  base_commit: z.string(), tree_sha: z.string(), snapshot_id: z.string().nullable(), patch: z.string(),
  files: z.array(NumstatRowSchema), external_changes: z.array(z.string()), review_flags: z.array(ReviewFlagSchema),
  patch_cut: PatchCutSchema.nullable().default(null),
})
export type DiffResponse = z.infer<typeof DiffResponseSchema>

/** GET /api/runs/:run_id/diff: what a run changed — in place, its own tool writes (with their attribution); a snapshot
 *  workspace, its tree at the end against its own baseline. 409 attribution_unavailable (with background_execution_ids)
 *  when no reliable baseline exists. */
export const RunDiffResponseSchema = z.object({
  run_id: z.string(),
  base_commit: z.string(),
  tree_sha: z.string(),
  files: z.array(NumstatRowSchema),
  patch: z.string(),
  patch_cut: PatchCutSchema.nullable().default(null),
  in_place: z.boolean().optional(),
  ...AttributionFieldsSchema.shape,
})
export type RunDiffResponse = z.infer<typeof RunDiffResponseSchema>

export const ModelEntrySchema = z.object({
  supported_thinking: z.array(z.string()).nullable().optional(),
  id: z.string(), label: z.string(), provider: z.string(), configured_model: z.string(), endpoint: z.string(), api: z.string(),
  auth: z.enum(['api_key', 'oauth']), account: z.string(), account_label: z.string().nullable(),
  credential: z.enum(['available', 'unavailable']), credential_source: z.enum(['oauth', 'stored', 'env']).nullable(),
  credential_hint: z.string().nullable(), credential_env: z.string().nullable(), context_window: z.number().int().nullable(),
  window_source: z.string(), concurrency: z.number().int().nullable(), slot_scope: z.string(),
  capabilities: z.record(z.string(), z.unknown()), capability_source: z.string(),
  pricing: z.record(z.string(), z.unknown()).nullable(), cost_basis: z.string(), default: z.boolean(),
  /** an OpenAI Responses route's reasoning mode ('pro'), a dimension of its own beside the effort; null otherwise */
  reasoning_mode: z.string().nullable().optional(),
  /** a Chat Completions route's reasoning field sent back to its endpoint (reasoning_content | reasoning_details); null: none */
  reasoning_replay: z.string().nullable().optional(),
})
export type ModelEntry = z.infer<typeof ModelEntrySchema>

export const BuildInfoSchema = z.object({
  package_version: z.string(), source_fingerprint: z.string(), api_version: z.string(), schema_version: z.number().int(),
  /** the UI build the backend serves (dist/build.json); null when there is none */
  ui_build: z.string().nullable(),
  isolation: z.object({ runtime: z.string(), enforcement: z.string() }), host: z.string(), port: z.number().int(),
  /** asked with `?challenge=`: the harness's answer, proving it holds the caller's session token (the desktop app's attach check) */
  attach_proof: z.string().optional(),
})
export type BuildInfo = z.infer<typeof BuildInfoSchema>

export const OutputWindowSchema = z.object({
  available: z.boolean().optional(), connection_state: RemoteConnectionStateSchema.optional(),
  target: TargetRefSchema.optional(), remote: RemoteExecutionRefSchema.nullable().optional(),
  execution_id: z.string(), stream: z.string(), offset: z.number().int(), returned_bytes: z.number().int(),
  total_bytes: z.number().int().nullable(), next_offset: z.number().int(), eof: z.boolean(), running: z.boolean(), status: z.string(),
  exit_code: z.number().int().nullable(), truncated_at_cap: z.boolean(), text: z.string(),
})
export type OutputWindow = z.infer<typeof OutputWindowSchema>

export const SurfaceToolSchema = z.object({
  name: z.string(), effect: z.string(), action: z.string().nullable(), renderer: z.string(), summary: z.string(), scope: z.string(),
})
export type SurfaceTool = z.infer<typeof SurfaceToolSchema>

export const RunControlSchema = z.object({
  desired_state: z.enum(['run', 'pause']), gate_effects: z.array(z.string()),
  run_id: z.string().nullable().optional(), entry_id: z.number().int().optional(),
})
export type RunControl = z.infer<typeof RunControlSchema>

export const ProposalDecisionSchema = z.object({
  // outcome (an approval): executing while it runs; after, done, failed, refused (nothing done when it ran) or unknown
  // (sent, its answer never came); executing with no process on it is interrupted
  decision: z.string(), reason: z.string().optional(), outcome: z.string().optional(), result_status: z.string().optional(), result_summary: z.string().optional(),
  decided_at: z.string(),
})
export const ActionProposalSchema = z.object({
  proposal_asset_id: z.string(), created_at: z.string(), tool_name: z.string(), run_id: z.string().nullable(),
  session_id: z.string().nullable(), status: z.string(), decision: ProposalDecisionSchema.nullable(),
  // what the call does, as the person reads it (null: a proposal made before labels were kept)
  label: z.string().nullable().optional(),
})
export type ActionProposal = z.infer<typeof ActionProposalSchema>

/** One folder of this machine as the folder dialog lists it: its subfolders (repositories marked), its parent, the favourites. */
export const DirListingSchema = z.object({
  path: z.string(), name: z.string(), parent: z.string().nullable(),
  entries: z.array(z.object({ name: z.string(), path: z.string(), repository: z.boolean() })),
  truncated: z.boolean(),
  favorites: z.array(z.object({ label: z.string(), path: z.string() })),
})
export type DirListing = z.infer<typeof DirListingSchema>

export const ReplayBodySchema = z.object({
  session_id: z.string(), runs: z.array(RunTreeRowSchema), events: z.array(ReplayEventSchema),
  t0: z.string().nullable(), t1: z.string().nullable(),
})
export type ReplayBody = z.infer<typeof ReplayBodySchema>

export const IntegrationResultSchema = z.object({
  status: z.string(), base_commit: z.string().nullable(), base_tree: z.string().nullable(), applied: z.array(z.string()),
  conflicts: z.array(z.string()), protected_hits: z.array(z.string()), integration_workspace_id: z.string().nullable(),
  composed_checkpoint_id: z.string().nullable(), composed_commit: z.string().nullable(), tree_sha: z.string().nullable(),
  files: z.array(NumstatRowSchema), checks: z.array(z.record(z.string(), z.unknown())), applied_to_workspace: z.boolean(),
  reason: z.string().nullable(), lock_violations: z.array(z.string()),
})
export type IntegrationResult = z.infer<typeof IntegrationResultSchema>

// ---- the context report -------------------------------------------------------------------------------------------

export const ContextSegmentSchema = z.object({
  key: z.string(), label: z.string(), bytes: z.number().int(), tokens: z.number().int().nullable(), tokens_est: z.number().int(),
  share: z.number(), sent: z.string(), count: z.number().int().optional(), note: z.string().optional(),
})
export type ContextSegment = z.infer<typeof ContextSegmentSchema>

export const CacheRequestSchema = z.object({
  seq: z.number().int(), input: z.number().int(), cache_read: z.number().int(), cache_write: z.number().int(),
  output: z.number().int(), latency_ms: z.number().int().nullable(),
})
export type CacheRequest = z.infer<typeof CacheRequestSchema>

/** GET /api/sessions/{id}/context — what the thread's next request carries. */
export const ContextReportSchema = z.object({
  schema_version: z.string(), session_id: z.string(), model_id: z.string().nullable(),
  total_bytes: z.number().int(), total_tokens: z.number().int().nullable(), tokenizer: z.string().nullable(), tokens_basis: z.string(),
  context_window: z.number().int().nullable(), context_window_source: z.string(),
  budget_tokens: z.number().int(), budget_source: z.string(), budget_note: z.string(),
  bytes_basis: z.string(),
  /** the context keeper's prediction for the next request (the one a compaction is decided on) and what it stands on */
  tokens_est: z.number().int(), estimate_basis: z.string(),
  segments: z.array(ContextSegmentSchema),
  per_message: z.array(z.string()),
  tools: z.array(z.string()),
  history: z.object({
    messages: z.number().int(), raw_bytes: z.number().int(), content_bytes: z.number().int(), wire_bytes: z.number().int(),
    wire_tokens: z.number().int().nullable(), compactions: z.number().int(), tool_returns: z.number().int(),
    model_turns: z.number().int(), user_turns: z.number().int(), bytes_basis: z.string(),
  }),
  last_run: z.object({
    run_id: z.string(), status: z.string(), created_at: z.string(), requests: z.number().optional(), tool_calls: z.number().optional(),
    input_tokens: z.number().optional(), output_tokens: z.number().optional(), total_tokens: z.number().optional(),
    cache_read_tokens: z.number().optional(), cache_write_tokens: z.number().optional(), model: z.string().optional(),
    configured_model: z.string().optional(), cost_usd: z.number().nullable().optional(), cost_cny: z.number().nullable().optional(), cost_status: z.string().optional(),
    history_bytes: z.number().optional(), history_content_bytes: z.number().optional(), history_wire_bytes: z.number().optional(),
    history_compactions: z.number().optional(), segments: z.number().optional(),
    last_request_input_tokens: z.number().int().nullable(), last_request_context_estimate: z.number().int().nullable(),
    tokens_basis: z.string().optional(),
    cache: z.object({
      scope: z.string(), requests: z.number().int(), recorded_requests: z.number().int(), hit_rate: z.number().nullable(),
      write_rate: z.number().nullable(), series: z.array(CacheRequestSchema), note: z.string(),
    }),
  }).nullable(),
})
export type ContextReport = z.infer<typeof ContextReportSchema>

// ---- accounts: subscriptions (OAuth) and API keys -------------------------------------------------------------------

export const QuotaWindowSchema = z.object({
  id: z.string(), label: z.string(), used_percent: z.number().nullable(), resets_at: z.string().nullable(),
  window_seconds: z.number().nullable(),
})
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>

export const AuthProviderIdSchema = z.enum(['openai-codex', 'anthropic', 'antigravity'])
export type AuthProviderId = z.infer<typeof AuthProviderIdSchema>

export const AccountUsageSchema = z.object({
  id: z.string(), provider: AuthProviderIdSchema, label: z.string(), source: z.enum(['harness', 'proxy']),
  account_label: z.string().nullable(), status: z.enum(['ok', 'stale', 'login_required', 'unavailable']),
  windows: z.array(QuotaWindowSchema), checked_at: z.string().nullable(), next_refresh_at: z.string(),
  error: z.string().nullable(), message: z.string().nullable(), plan: z.string().nullable(), mirrors: z.string().optional(),
})
export type AccountUsage = z.infer<typeof AccountUsageSchema>

export const UsageSnapshotSchema = z.object({
  accounts: z.array(AccountUsageSchema), server_time: z.string(), poll_interval_seconds: z.number(),
})
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>

export const LoginSessionSchema = z.object({
  id: z.string(), provider: AuthProviderIdSchema, url: z.string(),
  state: z.enum(['waiting', 'exchanging', 'done', 'failed', 'cancelled']), error: z.string().nullable(), paste_only: z.boolean(),
  expires_at: z.string(), account_label: z.string().nullable(),
})
export type LoginSession = z.infer<typeof LoginSessionSchema>

export const AuthProviderSchema = z.object({
  provider: AuthProviderIdSchema, label: z.string(),
  status: z.enum(['signed_out', 'ready', 'refresh_needed', 'login_required']), error: z.string().nullable(),
  account_label: z.string().nullable(), expires_at: z.string().nullable(), login: LoginSessionSchema.nullable(),
})
export type AuthProvider = z.infer<typeof AuthProviderSchema>

/** A built-in key provider, or the slug of a custom one the person added. */
export type KeyProviderId = 'anthropic-api' | 'openai-api' | 'gemini' | (string & {})

export const KeyRowSchema = z.object({
  provider: z.string(), label: z.string(), env: z.string(), unlocks: z.string(), docs: z.string(),
  source: z.enum(['stored', 'env']).nullable(), hint: z.string().nullable(), custom: z.boolean(),
})
export type KeyRow = z.infer<typeof KeyRowSchema>

export const AuthAccountsSchema = z.object({
  local: z.boolean(), providers: z.array(AuthProviderSchema), keys: z.array(KeyRowSchema),
})
export type AuthAccounts = z.infer<typeof AuthAccountsSchema>

export { CheckConfigSchema, GrantsSchema, LockSpecSchema }
