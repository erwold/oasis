/** Offline session share (docs: handoff design, not tracked): a strict, allowlisted snapshot of one quiescent session,
 *  built by the backend and turned by the page into ONE self-contained HTML file the person uploads where they choose.
 *
 *  The snapshot is a projection, never a dump: every field is named here, every string has passed the backend's one
 *  sanitizer, and nothing hidden (thinking, system/app prompts, provider fields, configuration, environment, raw tool
 *  arguments or returns, receipts, work orders) is carried behind the page. What was left out is counted in `stats`.
 *  Redaction of free prose is best-effort: unknown, encoded or image-borne secrets are not promised to be found. */

import { z } from 'zod'
import { ORIGIN_ACTORS, ORIGIN_REQUESTS, PARTICIPANT_ROLES, COLLAB_SURFACES, RUN_ID } from './collab_core.ts'
import { INTERACTION_NOTE_STATUSES } from './interaction.ts'
import { SHARE_BOTS } from './bots.ts'
import { ShareTeamSchema, SHARE_TEAM_LIMITS } from './agent_teams.ts'

export const SHARE_FORMAT = 'oasis-code.session-share' as const
/** The snapshot version the backend writes now (V2: V1's items plus `action` and `group_note`). */
export const SHARE_VERSION = 2 as const
/** The first snapshot version, frozen: its schema below never changes, so an old snapshot still reads. */
export const SHARE_VERSION_V1 = 1 as const

/** The bounds the backend enforces on one snapshot. */
export const SHARE_LIMITS = {
  /** items in the timeline; past it the rest is dropped and `stats.items_truncated` says so */
  max_items: 5_000,
  /** characters of one text field (a message, an answer); past it the field is cut and counted */
  max_text_chars: 200_000,
  /** characters of every string of every item together (texts, labels, targets, details); past it items are dropped */
  max_total_text_chars: 4_000_000,
  /** characters of a tool's preview (details only) */
  max_tool_preview_chars: 2_000,
  /** images carried (include_images only) */
  max_images: 40,
  /** bytes of one source image (PNG / JPEG / WebP as stored) */
  max_image_bytes: 5 * 1024 * 1024,
  /** bytes of every source image together */
  max_total_image_bytes: 20 * 1024 * 1024,
  /** the longest side of a source image the backend accepts */
  max_image_side: 8_000,
  /** width × height of one source image (16 MP: about 64 MB decoded as RGBA); a larger one is omitted as over_budget.
   *  The page decodes and re-encodes images one at a time, releasing each bitmap/canvas before the next. */
  max_image_pixels: 16_777_216,
  /** run ids one request may exclude */
  max_excluded_runs: 500,
  /** bytes of one run's stored conversation record parsed; a larger one is not parsed (its events stand in) */
  max_history_bytes: 32 * 1024 * 1024,
  /** bytes of stored conversation records parsed for one snapshot; past it the rest are not parsed */
  max_total_history_bytes: 128 * 1024 * 1024,
} as const

/** POST /api/sessions/:session_id/share-snapshot — strict: any other field is refused. */
export const ShareSnapshotRequestSchema = z.strictObject({
  /** tools' allowlisted result fields, short summary and output preview (filtered and redacted) */
  include_tool_details: z.boolean().default(false),
  /** the session's own validated raster images (attachments, screenshots, generated images) */
  include_images: z.boolean().default(false),
  /** runs of the session left out of the snapshot (their items are absent, counted in stats) */
  exclude_run_ids: z.array(z.string().regex(RUN_ID)).max(SHARE_LIMITS.max_excluded_runs).default([]),
})
export type ShareSnapshotRequest = z.infer<typeof ShareSnapshotRequestSchema>

const Key = z.string().regex(/^[a-z]{1,3}\d{1,6}$/)
const Text = z.string()
const Time = z.string().nullable()

export const SHARE_RUN_STATUSES = ['done', 'cancelled', 'error'] as const
export const ShareRunSchema = z.strictObject({
  /** share-local key (`r1`, …): never the harness's run id */
  key: Key,
  parent: Key.nullable(),
  /** the run whose conversation this run continued, when it is in the snapshot */
  continues: Key.nullable(),
  participant: Key.nullable(),
  role: z.enum(PARTICIPANT_ROLES).nullable(),
  surface: z.enum(COLLAB_SURFACES),
  group: Key.nullable(),
  started_by: z.enum(ORIGIN_ACTORS),
  request: z.enum(ORIGIN_REQUESTS),
  /** the connector client's label when a connector started it (ChatGPT, …) */
  client: Text.nullable(),
  label: Text.nullable(),
  model_label: Text,
  status: z.enum(SHARE_RUN_STATUSES),
  status_label: Text,
  started_at: Time,
  finished_at: Time,
  /** a failed run's error, sanitized and cut */
  error: Text.nullable(),
})
export type ShareRun = z.infer<typeof ShareRunSchema>

export const SHARE_PARTICIPANT_ROLES = [...PARTICIPANT_ROLES] as const
export const ShareParticipantSchema = z.strictObject({
  key: Key,
  role: z.enum(SHARE_PARTICIPANT_ROLES),
  label: Text,
  model_label: Text.nullable(),
})
export type ShareParticipant = z.infer<typeof ShareParticipantSchema>

/** Who wrote a message: the person, a director (this harness's or ChatGPT as director), a connector's client, a parent
 *  agent (a run's request to a child), the run's assistant — or unattributed: words the record holds whose sender it
 *  did not keep (never guessed to be the person). */
export const SHARE_AUTHORS = ['person', 'director', 'connector', 'agent', 'assistant', 'unattributed'] as const
export const ShareSteerSchema = z.strictObject({
  status: z.enum(['queued', 'delivered', 'undelivered']),
  /** the steer record's sender (a record from before `by` was kept is the person's, as steering.ts says); unrecorded:
   *  the conversation holds the words but no steer record of them survives */
  by: z.enum(['person', 'director', 'connector', 'unrecorded']),
  client: Text.nullable(),
  reason: Text.nullable(),
})
export const ShareMessageItemSchema = z.strictObject({
  kind: z.literal('message'),
  key: Key,
  run: Key.nullable(),
  at: Time,
  author: z.enum(SHARE_AUTHORS),
  author_label: Text,
  /** opening: the words that started the run; steer: words sent while it worked; answer: the assistant's */
  source: z.enum(['opening', 'steer', 'answer']),
  text: Text,
  steer: ShareSteerSchema.nullable(),
})

export const ShareToolFieldSchema = z.strictObject({ name: Text, value: z.union([Text, z.number(), z.boolean()]) })
export const ShareToolDetailsSchema = z.strictObject({
  summary: Text.nullable(),
  fields: z.array(ShareToolFieldSchema),
  /** a cut preview of what the tool printed/returned as the event recorded it — never its whole output */
  preview: Text.nullable(),
  preview_truncated: z.boolean(),
})
export const ShareToolItemSchema = z.strictObject({
  kind: z.literal('tool'),
  key: Key,
  run: Key.nullable(),
  at: Time,
  name: Text,
  status: Text,
  /** what it worked on (a project-relative path, a URL without its query, a command's head), sanitized */
  target: Text.nullable(),
  details: ShareToolDetailsSchema.nullable(),
  /** sensitive_source: its content is withheld whatever the options (an environment dump, a credential file, …) */
  withheld: z.enum(['sensitive_source']).nullable(),
})

/** One exchange with a director, as the thread shows it: a director turn of this harness (the person's words, or the
 *  harness's own question — a task event, an interaction's plan — said as a fixed line), with its answer once written;
 *  or a note a director mirrored on its own (ChatGPT as the director). A turn that failed or was cancelled keeps its
 *  question, with no answer and its status. */
export const ShareDirectorNoteItemSchema = z.strictObject({
  kind: z.literal('director_note'),
  key: Key,
  run: z.null(),
  at: Time,
  source_label: Text,
  model_label: Text,
  /** person: the person's words; app: the harness's own question (task event / interaction), a fixed line */
  asker: z.enum(['person', 'app']),
  question: Text,
  answer: Text.nullable(),
  status_label: Text,
})

export const ShareGroupItemSchema = z.strictObject({
  kind: z.literal('group'),
  key: Key,
  /** the group's share-local key (`g1`, …): what ShareRun.group names */
  group: Key,
  run: z.null(),
  at: Time,
  group_kind: z.enum(['relay', 'interaction']),
  /** who sent the group its message, from the collaboration graph's group origin: the person, a director (this
   *  harness's director turn), or a connector's client (`client`: ChatGPT, …) — never assumed to be the person */
  author: z.enum(['person', 'director', 'connector']),
  author_label: Text,
  client: Text.nullable(),
  /** the message the group was started with (relay/interaction user_text), shown once — never a turn's handover */
  text: Text,
  status_label: Text,
  participants: z.array(Key),
})

export const SHARE_IMAGE_ORIGINS = ['attachment', 'screenshot', 'generated'] as const
export const SHARE_IMAGE_OMISSIONS = ['images_off', 'missing', 'damaged', 'unsupported', 'over_budget'] as const
export const ShareImageItemSchema = z.strictObject({
  kind: z.literal('image'),
  key: Key,
  run: Key.nullable(),
  at: Time,
  origin: z.enum(SHARE_IMAGE_ORIGINS),
  /** the image's key in `images`, or null when it is not carried */
  image: Key.nullable(),
  omitted: z.enum(SHARE_IMAGE_OMISSIONS).nullable(),
})

export const SHARE_NOTICE_CODES = ['context_compacted', 'woken_by_watch', 'recorded_action', 'run_failed', 'run_stopped', 'history_unavailable'] as const
export const ShareNoticeItemSchema = z.strictObject({
  kind: z.literal('notice'),
  key: Key,
  run: Key.nullable(),
  at: Time,
  code: z.enum(SHARE_NOTICE_CODES),
  text: Text,
})

/** V1's items, frozen: these six kinds and nothing else. */
export const ShareItemV1Schema = z.discriminatedUnion('kind', [
  ShareMessageItemSchema, ShareToolItemSchema, ShareDirectorNoteItemSchema, ShareGroupItemSchema, ShareImageItemSchema, ShareNoticeItemSchema,
])
export type ShareItemV1 = z.infer<typeof ShareItemV1Schema>

/** What an action row recorded (receipt.mechanical.human_action); `other` for a row that names none the app knows. */
export const SHARE_ACTION_KINDS = ['command', 'checkpoint', 'verify', 'integrate', 'approve_proposal', 'other'] as const
/** V2: an action taken beside the agents — a connector's or the person's command, checkpoint, checks, integration,
 *  adoption, an approved proposal — as the thread's action line shows it (contract/src/actions.ts reads both). Its run
 *  (`run`, surface `record`) is in `runs`; it has no turn of its own: nothing else of that run is an item.
 *
 *  `what` and `by` are threadActionLabel(label) of the row's label; `head` and `outcome` are threadActionLines(text) of `text` —
 *  the same values ThreadAction holds — each sanitized. `text` is the row's whole text, sanitized (at most
 *  max_text_chars): what opening the line shows. A command's execution id never appears (`→ running`, not
 *  `→ running (x_…)`); harness references in a generated text (checkpoint, proposal, run ids) are masked.
 *  `details` (include_tool_details only, a command only): the execution's measured scalars and a cut preview of its
 *  stored output, as a tool's details. A sensitive source (an environment dump, a credential file, a sensitive cwd):
 *  `head`, `text` and `details` are null and `withheld` says so; `outcome` stays only as `→ exit N` / `→ running`. */
export const ShareActionItemSchema = z.strictObject({
  kind: z.literal('action'),
  key: Key,
  run: Key,
  at: Time,
  action: z.enum(SHARE_ACTION_KINDS),
  /** person: taken by hand (or a label that names no one); connector: a connector's client took it */
  actor: z.enum(['person', 'connector']),
  /** ThreadAction.what: the label's word (`command`, `checkpoint`, `approved bash`) */
  what: Text,
  /** ThreadAction.by: the client the label names (`ChatGPT`, `connector`), null for the person */
  by: Text.nullable(),
  /** ThreadAction.head; null when withheld */
  head: Text.nullable(),
  /** ThreadAction.outcome (`→ exit 0`, `→ running`); null when the text has none */
  outcome: Text.nullable(),
  /** ThreadAction.text, sanitized; null when withheld */
  text: Text.nullable(),
  details: ShareToolDetailsSchema.nullable(),
  withheld: z.enum(['sensitive_source']).nullable(),
})
export type ShareActionItem = z.infer<typeof ShareActionItemSchema>

/** V2: the person's words to the members of a group (an interaction note: MemberWords), where the thread shows them.
 *  `to` is the addressee as the app names it (participantName), null for everyone; `delivered_to` the addressees it was
 *  handed to, named the same way and sorted (noteState's names). */
export const ShareGroupNoteItemSchema = z.strictObject({
  kind: z.literal('group_note'),
  key: Key,
  run: z.null(),
  at: Time,
  group: Key,
  to: Text.nullable(),
  text: Text,
  status: z.enum(INTERACTION_NOTE_STATUSES),
  delivered_to: z.array(Text),
})
export type ShareGroupNoteItem = z.infer<typeof ShareGroupNoteItemSchema>

/** V2's items: V1's six kinds, an action, a group note. */
export const ShareItemV2Schema = z.discriminatedUnion('kind', [
  ShareMessageItemSchema, ShareToolItemSchema, ShareDirectorNoteItemSchema, ShareGroupItemSchema, ShareImageItemSchema, ShareNoticeItemSchema,
  ShareActionItemSchema, ShareGroupNoteItemSchema,
])
export type ShareItemV2 = z.infer<typeof ShareItemV2Schema>
/** The latest version's items. */
export const ShareItemSchema = ShareItemV2Schema
export type ShareItem = ShareItemV2

export const ShareImageSchema = z.strictObject({
  key: Key,
  media_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** the source bytes' length (before the page re-encodes them) */
  bytes: z.number().int().positive(),
  /** the source bytes, base64 — the page must decode, check they are a raster image, and re-encode (dropping metadata) */
  data_base64: z.string(),
})
export type ShareImage = z.infer<typeof ShareImageSchema>

const Count = z.number().int().nonnegative()
export const SHARE_OMISSION_KEYS = [
  'thinking', 'app_notes', 'compaction_summaries', 'system_prompts', 'retry_prompts', 'unknown_parts', 'tool_details',
  'sensitive_tool_content', 'ui_surfaces', 'ui_inputs', 'runs_excluded', 'images_off', 'images_missing', 'images_damaged',
  'images_unsupported', 'images_over_budget', 'images_workspace_files', 'histories_unreadable', 'histories_over_budget',
] as const
export const SHARE_REDACTION_KEYS = [
  'session_token', 'private_key', 'auth_header', 'credential_url', 'secret_pattern', 'credential_assignment', 'path',
  'username', 'email', 'invisible_chars',
] as const
export const ShareStatsSchema = z.strictObject({
  omitted: z.strictObject(Object.fromEntries(SHARE_OMISSION_KEYS.map((k) => [k, Count])) as Record<(typeof SHARE_OMISSION_KEYS)[number], typeof Count>),
  redacted: z.strictObject(Object.fromEntries(SHARE_REDACTION_KEYS.map((k) => [k, Count])) as Record<(typeof SHARE_REDACTION_KEYS)[number], typeof Count>),
  truncated_fields: Count,
  items_truncated: z.boolean(),
})
export type ShareStats = z.infer<typeof ShareStatsSchema>

/** V1's limit keys, frozen (a later limit added to SHARE_LIMITS never changes V1). */
export const SHARE_LIMITS_V1_KEYS = [
  'max_items', 'max_text_chars', 'max_total_text_chars', 'max_tool_preview_chars', 'max_images', 'max_image_bytes', 'max_total_image_bytes',
  'max_image_side', 'max_image_pixels', 'max_excluded_runs', 'max_history_bytes', 'max_total_history_bytes',
] as const
const LimitsV1 = z.strictObject(Object.fromEntries(SHARE_LIMITS_V1_KEYS.map((k) => [k, z.number().int()])) as Record<(typeof SHARE_LIMITS_V1_KEYS)[number], z.ZodNumber>)
const SessionMeta = z.strictObject({ created_at: Time, last_activity_at: Time, model_label: Text })
const Options = z.strictObject({ include_tool_details: z.boolean(), include_images: z.boolean() })

/** The first version, frozen: a snapshot written before V2 reads with it unchanged. */
export const ShareSnapshotV1Schema = z.strictObject({
  format: z.literal(SHARE_FORMAT),
  version: z.literal(SHARE_VERSION_V1),
  generated_at: z.string(),
  title: Text,
  session: SessionMeta,
  options: Options,
  participants: z.array(ShareParticipantSchema),
  runs: z.array(ShareRunSchema),
  items: z.array(ShareItemV1Schema),
  images: z.array(ShareImageSchema),
  stats: ShareStatsSchema,
  limits: LimitsV1,
})
export type ShareSnapshotV1 = z.infer<typeof ShareSnapshotV1Schema>

/** V2: V1 with the action and group-note items. Stats, limits and notice codes are V1's. */
export const ShareSnapshotV2Schema = z.strictObject({
  format: z.literal(SHARE_FORMAT),
  version: z.literal(SHARE_VERSION),
  generated_at: z.string(),
  title: Text,
  session: SessionMeta,
  options: Options,
  participants: z.array(ShareParticipantSchema),
  runs: z.array(ShareRunSchema),
  items: z.array(ShareItemV2Schema),
  images: z.array(ShareImageSchema),
  stats: ShareStatsSchema,
  limits: z.strictObject(Object.fromEntries(Object.keys(SHARE_LIMITS).map((k) => [k, z.number().int()])) as Record<keyof typeof SHARE_LIMITS, z.ZodNumber>),
})
export type ShareSnapshotV2 = z.infer<typeof ShareSnapshotV2Schema>

/** Any version a reader accepts (by `version`); an unknown or future version is refused. */
export const ShareSnapshotSchema = z.discriminatedUnion('version', [ShareSnapshotV1Schema, ShareSnapshotV2Schema])
export type ShareSnapshot = z.infer<typeof ShareSnapshotSchema>

/** The run choice the dialog offers (real run id → share key): never part of the snapshot, never written to the HTML. */
export const ShareSelectionSchema = z.strictObject({
  runs: z.array(z.strictObject({ run_id: z.string(), key: Key, label: Text, status: z.enum(SHARE_RUN_STATUSES) })),
})
/** The backend always answers with the latest version. */
export const ShareSnapshotResponseSchema = z.strictObject({ snapshot: ShareSnapshotV2Schema, selection: ShareSelectionSchema })
export type ShareSnapshotResponse = z.infer<typeof ShareSnapshotResponseSchema>

/** The 409 code of a session with work under way (only a quiescent session is exported). */
export const SHARE_ACTIVE_CODE = 'session_active' as const

// ---- V3: the Agent Teams card, the transcript's faces, and every session of the task ----------------------------------
/* V3 is new; V1 and V2 above are frozen and untouched. A V3 snapshot holds one session (the one shared) or — when the
 * person asks for the task — every session of its task that is not deleted (repo.sessionsOfTask: by task relation only,
 * across projects), never a part of them: a task too large is refused whole (413), never shared with sessions missing.
 * Every session carries its own runs, items, images (image keys are the session's own: `img1` of one session is never
 * another's picture), its Agent Teams card and the rail's bots; every bot is a NAME the backend computed from the real
 * ids with contract/src/bots.ts (the ids never leave). The budgets of SHARE_LIMITS hold for the whole snapshot. */

/** The version V3 snapshots carry. SHARE_VERSION stays 2: the frozen route still answers V2. */
export const SHARE_VERSION_V3 = 3 as const

export const SHARE_LIMITS_V3 = {
  ...SHARE_LIMITS,
  /** sessions of one task shared at once; a task with more is refused whole (413 share_too_large) */
  max_sessions: 128,
  max_team_rows: SHARE_TEAM_LIMITS.max_team_rows,
  /** bytes of the whole V3 answer as JSON (every session's runs, cards and titles, the pictures' base64 included);
   *  past it the share is refused whole (413 share_too_large), never cut */
  max_snapshot_bytes: 64 * 1024 * 1024,
} as const
/** The 413 code of a share past max_sessions or max_snapshot_bytes (refused whole). */
export const SHARE_TOO_LARGE_CODE = 'share_too_large' as const

/** POST /api/sessions/:session_id/share-snapshot/v3 — strict. */
export const ShareSnapshotV3RequestSchema = z.strictObject({
  include_tool_details: z.boolean().default(false),
  include_images: z.boolean().default(false),
  /** runs left out, of any session shared */
  exclude_run_ids: z.array(z.string().regex(RUN_ID)).max(SHARE_LIMITS.max_excluded_runs).default([]),
  /** every session of this session's task (not deleted), not only this one; the dialog leaves it off */
  include_task_sessions: z.boolean().default(false),
})
export type ShareSnapshotV3Request = z.infer<typeof ShareSnapshotV3RequestSchema>

/** A run with the face its turn wears in the thread (ThreadTranscript turnFace, contract bots.ts turnFaceOf). */
export const ShareRunV3Schema = z.strictObject({ ...ShareRunSchema.shape, bot: z.enum(SHARE_BOTS).nullable(), enclosed: z.boolean() })
export type ShareRunV3 = z.infer<typeof ShareRunV3Schema>

export const ShareScopeSchema = z.enum(['session', 'task'])
const OptionsV3 = z.strictObject({ include_tool_details: z.boolean(), include_images: z.boolean(), include_task_sessions: z.boolean() })

/** One session of a V3 snapshot. */
export const ShareSessionV3Schema = z.strictObject({
  /** share-local (`s1`, …) */
  key: Key,
  title: Text,
  /** a session that joined the task (the rail indents it); false for the task's first session */
  member: z.boolean(),
  /** the session the share was made from */
  current: z.boolean(),
  /** the rail's bots of the session (bots.ts sessionBots), in the rail's order */
  bots: z.array(z.enum(SHARE_BOTS)),
  session: SessionMeta,
  participants: z.array(ShareParticipantSchema),
  runs: z.array(ShareRunV3Schema),
  items: z.array(ShareItemV2Schema),
  /** this session's pictures only; an image item names a key of THIS list */
  images: z.array(ShareImageSchema),
  team: ShareTeamSchema,
  stats: ShareStatsSchema,
})
export type ShareSessionV3 = z.infer<typeof ShareSessionV3Schema>

/** V3's fields, checked field by field — without the cross checks (ShareSnapshotV3Schema adds them). A page document
 *  that carries its pictures beside the snapshot (sessions' `images` empty) checks this, then shareSnapshotV3Problems with
 *  its own pictures as each session's images; the server's answer is always checked whole with ShareSnapshotV3Schema. */
export const ShareSnapshotV3BodySchema = z.strictObject({
  format: z.literal(SHARE_FORMAT),
  version: z.literal(SHARE_VERSION_V3),
  generated_at: z.string(),
  /** the title of the session the share was made from */
  title: Text,
  scope: ShareScopeSchema,
  /** the key of the session the share was made from */
  current: Key,
  options: OptionsV3,
  /** the rail's order: the task's first session (when not deleted), then the others by latest activity */
  sessions: z.array(ShareSessionV3Schema).min(1),
  /** every session's stats added up */
  stats: ShareStatsSchema,
  limits: z.strictObject(Object.fromEntries(Object.keys(SHARE_LIMITS_V3).map((k) => [k, z.number().int()])) as Record<keyof typeof SHARE_LIMITS_V3, z.ZodNumber>),
})

/** What is wrong across V3's fields (empty: nothing): session keys repeated, a picture another session's (an image item
 *  must name a key of its OWN session's images — or, for a page document, of `imagesOf(session key)`), a team row
 *  naming a run of no such key, not exactly one current session, a session share of more than one session. */
export function shareSnapshotV3Problems(s: z.infer<typeof ShareSnapshotV3BodySchema>, imagesOf?: (sessionKey: string) => ReadonlySet<string>): string[] {
  const out: string[] = []
  const keys = new Set<string>()
  let current = 0
  for (const session of s.sessions) {
    if (keys.has(session.key)) out.push(`session key ${session.key} repeated`)
    keys.add(session.key)
    if (session.current) current++
    const listed = session.images.map((i) => i.key)
    if (new Set(listed).size !== listed.length) out.push(`session ${session.key}: image key repeated`)
    const own = imagesOf ? imagesOf(session.key) : new Set(listed)
    for (const item of session.items) if (item.kind === 'image' && item.image !== null && !own.has(item.image)) out.push(`session ${session.key}: image ${item.image} is no image of this session`)
    const runs = new Set(session.runs.map((r) => r.key))
    for (const row of session.team.rows) if (row.turn !== null && !runs.has(row.turn)) out.push(`session ${session.key}: team row ${row.key} names no run of this session`)
  }
  if (current !== 1 || !s.sessions.some((x) => x.current && x.key === s.current)) out.push('exactly one current session, the one `current` names')
  if (s.scope === 'session' && s.sessions.length !== 1) out.push('a session share holds one session')
  return out
}

/** The V3 snapshot the server answers with: its fields and every cross check (a picture only ever its own session's). */
export const ShareSnapshotV3Schema = ShareSnapshotV3BodySchema.superRefine((s, ctx) => {
  for (const message of shareSnapshotV3Problems(s)) ctx.addIssue({ code: 'custom', message })
})
export type ShareSnapshotV3 = z.infer<typeof ShareSnapshotV3Schema>

/** Any version a reader of today accepts (by `version`): V1, V2, V3. ShareSnapshotSchema (V1 | V2) is unchanged. */
export const ShareSnapshotAnySchema = z.union([ShareSnapshotV1Schema, ShareSnapshotV2Schema, ShareSnapshotV3Schema])
export type ShareSnapshotAny = z.infer<typeof ShareSnapshotAnySchema>
/** A page document's snapshot (its pictures beside it): V1, V2, or V3's fields — the caller runs
 *  shareSnapshotV3Problems on a V3 with its pictures as each session's images. */
export const ShareSnapshotDocumentAnySchema = z.union([ShareSnapshotV1Schema, ShareSnapshotV2Schema, ShareSnapshotV3BodySchema])

/** The dialog's run choice of a V3 share (never part of the snapshot). */
export const ShareSelectionV3Schema = z.strictObject({
  runs: z.array(z.strictObject({ run_id: z.string(), session: Key, key: Key, label: Text, status: z.enum(SHARE_RUN_STATUSES) })),
})
export const ShareSnapshotV3ResponseSchema = z.strictObject({ snapshot: ShareSnapshotV3Schema, selection: ShareSelectionV3Schema })
export type ShareSnapshotV3Response = z.infer<typeof ShareSnapshotV3ResponseSchema>

/** One session of a V3 snapshot in V2's shape (its runs without their faces), for the V2 thread renderer. */
export function shareSessionAsV2(snapshot: ShareSnapshotV3, key: string): ShareSnapshotV2 | null {
  const s = snapshot.sessions.find((x) => x.key === key)
  if (!s) return null
  return {
    format: SHARE_FORMAT, version: SHARE_VERSION, generated_at: snapshot.generated_at, title: s.title, session: s.session,
    options: { include_tool_details: snapshot.options.include_tool_details, include_images: snapshot.options.include_images },
    participants: s.participants, runs: s.runs.map(({ bot: _bot, enclosed: _enclosed, ...run }) => run), items: s.items, images: s.images, stats: s.stats,
    limits: Object.fromEntries(Object.keys(SHARE_LIMITS).map((k) => [k, snapshot.limits[k as keyof typeof SHARE_LIMITS]])) as ShareSnapshotV2['limits'],
  }
}
