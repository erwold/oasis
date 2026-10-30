/** Live read-only session sharing (docs/live-session-share.md): one session, watched while it works, through a link the
 *  person makes. A separate share-only listener (default off) serves exactly the viewer page, its two assets, one event
 *  stream and the stream's images — never the app's router, its session token, or the gateway's connector routes.
 *
 *  What a viewer receives is a whole safe state each time (no item patches, no replay): the same strict projection as
 *  the offline share (contract/src/share.ts; every string through the backend's one sanitizer, the same field
 *  whitelist, the same sensitive-source rules), with runs still queued or running, and an answer still being written
 *  shown up to its last completed line (`message_open`). The offline snapshot's V1 / V2 schemas are frozen and not
 *  touched by this module: the live state is a format of its own (`oasis-code.session-live`, version 1).
 *
 *  A link's capability is a 256-bit value derived on the backend (HMAC-SHA256 under a private share key) — never the
 *  app's session token. The URL carries it in the fragment (`<origin>/live/#<capability>`), which a browser does not put
 *  in the request URL; the viewer sends it as `Authorization: Bearer <capability>`, which does reach the origin and any
 *  hop that terminates the transport (a tunnel's edge): protected by that transport's encryption, not hidden from it. */

import { z } from 'zod'
import { RUN_ID } from './collab_core.ts'
import {
  SHARE_LIMITS, ShareActionItemSchema, ShareDirectorNoteItemSchema, ShareGroupItemSchema, ShareGroupNoteItemSchema, ShareMessageItemSchema,
  ShareNoticeItemSchema, ShareParticipantSchema, ShareRunSchema, ShareStatsSchema, ShareToolItemSchema, SHARE_IMAGE_ORIGINS, SHARE_IMAGE_OMISSIONS,
} from './share.ts'
import { SHARE_BOTS } from './bots.ts'
import { ShareTeamSchema } from './agent_teams.ts'

export const LIVE_SHARE_FORMAT = 'oasis-code.session-live' as const
/** The live state's version: a viewer refuses any other (and says to reload the page). */
export const LIVE_SHARE_VERSION = 1 as const
export const LIVE_SHARE_DEFAULT_PORT = 8325

/** The bounds the backend holds the live share to. */
export const LIVE_SHARE_LIMITS = {
  /** a link's lifetime: at least 5 minutes, at most 30 days (the dialog's default: one day) */
  min_expiry_s: 300,
  max_expiry_s: 30 * 24 * 3600,
  default_expiry_s: 24 * 3600,
  /** links of one session not yet revoked or expired */
  max_active_links_per_session: 20,
  /** distinct projections (session × options) kept at once; a viewer of one more is refused (busy) */
  max_projections: 8,
  /** open streams of one link, and of the whole listener */
  max_viewers_per_link: 25,
  max_viewers_total: 100,
  /** bytes of one serialized state frame; past it the latest items are dropped and `stats.items_truncated` says so */
  max_state_bytes: 16 * 1024 * 1024,
  /** a quiet stream says it is alive this often (a comment line) */
  heartbeat_ms: 15_000,
  /** labels the person gives a link */
  max_label_chars: 120,
} as const

// ---- the person's side (the app's own API, owner-only) ----------------------------------------------------------------

export const LIVE_SHARE_BINDS = ['loopback', 'lan'] as const
/** The share listener's settings (`<data dir>/live-share.json`). `bind`: loopback = 127.0.0.1 only (a tunnel the person
 *  runs, a Cloudflare named tunnel say, brings a public name to it); lan = 0.0.0.0 (every interface: the local network).
 *  `public_base_url`: the origin the copied link names (`https://share.example.com`, `http://192.0.2.20:8325`);
 *  null: loopback's own `http://127.0.0.1:<port>`, and no URL at all for lan (the address cannot be guessed). */
export const LiveShareSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  bind: z.enum(LIVE_SHARE_BINDS),
  port: z.number().int().min(1024).max(65535),
  public_base_url: z.string().max(200).nullable(),
})
export type LiveShareSettings = z.infer<typeof LiveShareSettingsSchema>
export const LIVE_SHARE_DEFAULT_SETTINGS: LiveShareSettings = { enabled: false, bind: 'loopback', port: LIVE_SHARE_DEFAULT_PORT, public_base_url: null }

/** What the listener is doing now. `address`: host:port it listens on (null when not listening); `error`: why it is not
 *  listening although enabled (a port taken, …), null otherwise. */
export const LiveShareStatusSchema = z.strictObject({
  listening: z.boolean(),
  address: z.string().nullable(),
  error: z.string().nullable(),
  /** open viewer streams, all links */
  viewers: z.number().int().nonnegative(),
  /** the viewer page's built files are where the listener reads them (frontend/dist/live-share/) */
  viewer_built: z.boolean(),
})
export type LiveShareStatus = z.infer<typeof LiveShareStatusSchema>

/** GET and PUT /api/settings/live-share answer with both. PUT takes LiveShareSettingsSchema (the whole object). */
export const LiveShareSettingsResponseSchema = z.strictObject({ settings: LiveShareSettingsSchema, status: LiveShareStatusSchema })
export type LiveShareSettingsResponse = z.infer<typeof LiveShareSettingsResponseSchema>

export const SHARE_LINK_ID = /^sl_[A-Za-z0-9_-]{22}$/
/** A capability: 32 bytes, base64url without padding. */
export const LIVE_CAPABILITY = /^[A-Za-z0-9_-]{43}$/

/** What a link shows, fixed when it is made (canonical: exclude_run_ids sorted, without repeats). */
export const ShareLinkOptionsSchema = z.strictObject({
  include_tool_details: z.boolean(),
  include_images: z.boolean(),
  exclude_run_ids: z.array(z.string().regex(RUN_ID)).max(SHARE_LIMITS.max_excluded_runs),
})
export type ShareLinkOptions = z.infer<typeof ShareLinkOptionsSchema>

/** POST /api/sessions/:session_id/share-links — strict. */
export const ShareLinkCreateRequestSchema = z.strictObject({
  label: z.string().max(LIVE_SHARE_LIMITS.max_label_chars).default(''),
  expires_in_s: z.number().int().min(LIVE_SHARE_LIMITS.min_expiry_s).max(LIVE_SHARE_LIMITS.max_expiry_s).default(LIVE_SHARE_LIMITS.default_expiry_s),
  include_tool_details: z.boolean().default(false),
  include_images: z.boolean().default(false),
  exclude_run_ids: z.array(z.string().regex(RUN_ID)).max(SHARE_LIMITS.max_excluded_runs).default([]),
})
export type ShareLinkCreateRequest = z.infer<typeof ShareLinkCreateRequestSchema>

export const SHARE_LINK_STATES = ['active', 'expired', 'revoked'] as const
/** revoked: the person revoked it; session_deleted: its session was deleted */
export const SHARE_LINK_REVOKE_REASONS = ['revoked', 'session_deleted'] as const

/** A link as the person's page lists it: never its capability (reveal says that, on the person's POST). */
export const ShareLinkSchema = z.strictObject({
  id: z.string().regex(SHARE_LINK_ID),
  session_id: z.string(),
  label: z.string(),
  options: ShareLinkOptionsSchema,
  created_at: z.string(),
  expires_at: z.string(),
  revoked_at: z.string().nullable(),
  revoked_reason: z.enum(SHARE_LINK_REVOKE_REASONS).nullable(),
  state: z.enum(SHARE_LINK_STATES),
  /** viewer streams of this link open now */
  viewers: z.number().int().nonnegative(),
})
export type ShareLink = z.infer<typeof ShareLinkSchema>

/** GET /api/sessions/:session_id/share-links — every link of the session, newest first (revoked and expired too). */
export const ShareLinkListResponseSchema = z.strictObject({ links: z.array(ShareLinkSchema) })
export type ShareLinkListResponse = z.infer<typeof ShareLinkListResponseSchema>

/** POST /api/sessions/:session_id/share-links and POST /api/share-links/:id/reveal. `url` is
 *  `<origin>/live/#<capability>`, or null when no origin is known (lan with no public_base_url). */
export const ShareLinkSecretResponseSchema = z.strictObject({
  link: ShareLinkSchema,
  capability: z.string().regex(LIVE_CAPABILITY),
  url: z.string().nullable(),
})
export type ShareLinkSecretResponse = z.infer<typeof ShareLinkSecretResponseSchema>

/** POST /api/share-links/:id/revoke — the link as it stands now (revoking twice is not an error). */
export const ShareLinkRevokeResponseSchema = z.strictObject({ link: ShareLinkSchema })
export type ShareLinkRevokeResponse = z.infer<typeof ShareLinkRevokeResponseSchema>

// ---- the viewer's side (the share listener) ---------------------------------------------------------------------------

const Key = z.string().regex(/^[a-z]{1,3}\d{1,6}$/)
const Time = z.string().nullable()
/** A live image's resource id: opaque (an HMAC under a random salt of its projection — session × options — over the
 *  asset and its stripped bytes), stable while that projection lives, never positional (no `img1` that a later state
 *  could give another picture), never an asset id or a digest a viewer could guess. The image route answers only for a
 *  resource of the link's CURRENT projection: a picture of an excluded run, another session or other options is 404. */
export const LIVE_IMAGE_RESOURCE = /^m[0-9a-f]{24}$/
const ImageResource = z.string().regex(LIVE_IMAGE_RESOURCE)

export const LIVE_RUN_STATUSES = ['queued', 'running', 'done', 'cancelled', 'error'] as const
/** A run as the offline share says it, its status also queued or running (finished_at null then). */
export const LiveRunSchema = z.strictObject({ ...ShareRunSchema.shape, status: z.enum(LIVE_RUN_STATUSES) })
export type LiveRun = z.infer<typeof LiveRunSchema>

/** The answer a running run is writing now: its text up to the last completed line (sanitized like every other text),
 *  the line being written withheld (`withheld_tail`) — and the whole of it withheld while it may be inside a structure
 *  that can hide a secret over several lines (a private key block, a multi-line value of a secret-named key). Once the
 *  answer is complete it is an ordinary `message` item. */
export const LiveOpenMessageItemSchema = z.strictObject({
  kind: z.literal('message_open'),
  key: Key,
  run: Key,
  at: Time,
  author: z.literal('assistant'),
  author_label: z.string(),
  text: z.string(),
  withheld_tail: z.boolean(),
})
export type LiveOpenMessageItem = z.infer<typeof LiveOpenMessageItemSchema>

/** An image item: `image` is the RESOURCE id of a live image ref (`images[].resource`, fetched from
 *  /live/api/image/<resource>), or null with `omitted`. The frozen ShareItemV2 image item (positional `img1` keys) is
 *  not used live. */
export const LiveImageItemSchema = z.strictObject({
  kind: z.literal('image'),
  key: Key,
  run: Key.nullable(),
  at: Time,
  origin: z.enum(SHARE_IMAGE_ORIGINS),
  image: ImageResource.nullable(),
  omitted: z.enum(SHARE_IMAGE_OMISSIONS).nullable(),
})

/** The live items: the offline V2 kinds (a tool's `status` may be `running`), the live image item, the open answer. */
export const LiveItemSchema = z.discriminatedUnion('kind', [
  ShareMessageItemSchema, ShareToolItemSchema, ShareDirectorNoteItemSchema, ShareGroupItemSchema, LiveImageItemSchema, ShareNoticeItemSchema,
  ShareActionItemSchema, ShareGroupNoteItemSchema, LiveOpenMessageItemSchema,
])
export type LiveItem = z.infer<typeof LiveItemSchema>

/** An image the stream can serve: its bytes are the session's own raster with its metadata stripped by the backend
 *  (PNG / JPEG / WebP chunks and segments outside an allowlist removed, trailing bytes dropped — not a re-encode). */
export const LiveImageRefSchema = z.strictObject({
  resource: ImageResource,
  media_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** the stripped bytes' length (what the image route answers with) */
  bytes: z.number().int().positive(),
})
export type LiveImageRef = z.infer<typeof LiveImageRefSchema>

export const LiveSnapshotSchema = z.strictObject({
  format: z.literal(LIVE_SHARE_FORMAT),
  version: z.literal(LIVE_SHARE_VERSION),
  generated_at: z.string(),
  title: z.string(),
  session: z.strictObject({ created_at: Time, last_activity_at: Time, model_label: z.string(), active: z.boolean() }),
  options: z.strictObject({ include_tool_details: z.boolean(), include_images: z.boolean() }),
  participants: z.array(ShareParticipantSchema),
  runs: z.array(LiveRunSchema),
  items: z.array(LiveItemSchema),
  images: z.array(LiveImageRefSchema),
  stats: ShareStatsSchema,
  limits: z.strictObject(Object.fromEntries(Object.keys(SHARE_LIMITS).map((k) => [k, z.number().int()])) as Record<keyof typeof SHARE_LIMITS, z.ZodNumber>),
})
export type LiveSnapshot = z.infer<typeof LiveSnapshotSchema>

/** SSE `event: state`, `id: <epoch>.<revision>`: the whole latest safe state. Every connect and reconnect starts with
 *  the latest one (Last-Event-ID is not replayed after); `epoch` changes when the backend restarts or the projection is
 *  made again, `revision` grows within an epoch. */
export const LiveStateFrameSchema = z.strictObject({
  epoch: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
  revision: z.number().int().positive(),
  /** when the link stops working (the viewer may say so) */
  expires_at: z.string(),
  snapshot: LiveSnapshotSchema,
})
export type LiveStateFrame = z.infer<typeof LiveStateFrameSchema>

/** SSE `event: ended`, then the stream closes. revoked / expired / session_deleted: for good (the viewer stops);
 *  disabled: the person turned the listener off; server_closing: the app is stopping (both: retry later). */
export const LIVE_ENDED_REASONS = ['revoked', 'expired', 'session_deleted', 'disabled', 'server_closing'] as const
export const LiveEndedFrameSchema = z.strictObject({ reason: z.enum(LIVE_ENDED_REASONS) })
export type LiveEndedFrame = z.infer<typeof LiveEndedFrameSchema>
export const LIVE_PERMANENT_END: readonly (typeof LIVE_ENDED_REASONS)[number][] = ['revoked', 'expired', 'session_deleted']

/** The listener's error bodies (JSON `{ error }`): unauthorized (401: no or unknown capability), gone (410: revoked,
 *  expired or session deleted — `reason` says which), busy (429 / 503: viewer or projection bounds), not_found (404),
 *  method_not_allowed (405), forbidden (403), unavailable (503: viewer not built / projector down). */
export const LIVE_ERROR_CODES = ['unauthorized', 'gone', 'busy', 'not_found', 'method_not_allowed', 'forbidden', 'unavailable'] as const
export const LiveErrorSchema = z.strictObject({ error: z.enum(LIVE_ERROR_CODES), reason: z.enum(LIVE_ENDED_REASONS).optional() })
export type LiveError = z.infer<typeof LiveErrorSchema>

/** The listener's exact paths. */
export const LIVE_PATHS = {
  page: '/live/',
  script: '/live/assets/live-share.js',
  style: '/live/assets/live-share.css',
  stream: '/live/api/stream',
  image_prefix: '/live/api/image/',
} as const

// ---- v2: the Agent Teams card, the faces, and every session of a task ---------------------------------------------
/* Protocol 2 is new; everything above (format version 1, its frames, its link shapes, its capability domain) is frozen.
 * A v1 link keeps answering v1 frames. A v2 link shows one session, or — made with include_task_sessions — every
 * session of its task that is not deleted, now and later (the task is fixed when the link is made: `task_root_id`; a
 * session that joins the task later appears, a deleted one disappears; the session the link was made from being
 * deleted does not end the link — the last session of the task deleted does, `session_deleted`). A task the listener
 * cannot hold whole (its projection budget) is never shown with sessions missing: the stream ends `busy` (v2 only) and
 * the viewer tries again later. Revocation and expiry end the whole view. */

export const LIVE_SHARE_VERSION_V2 = 2 as const
export const LIVE_SHARE_PROTOCOLS = [1, 2] as const

export const LIVE_SHARE_LIMITS_V2 = {
  /** bytes of one session's part of a v2 state, whatever the frame it is in: floor((16 MiB − 64 KiB) / 8). A frame holds
   *  at most max_projections (8) parts, so parts and envelope stay within max_state_bytes */
  max_part_bytes: Math.floor((LIVE_SHARE_LIMITS.max_state_bytes - 64 * 1024) / LIVE_SHARE_LIMITS.max_projections),
  /** bytes of everything of a frame but its parts (the frame's head, the snapshot's own fields, separators) */
  max_envelope_bytes: 64 * 1024,
} as const

/** POST /api/sessions/:session_id/share-links/v2 — strict. */
export const ShareLinkCreateV2RequestSchema = z.strictObject({
  ...ShareLinkCreateRequestSchema.shape,
  include_task_sessions: z.boolean().default(false),
})
export type ShareLinkCreateV2Request = z.infer<typeof ShareLinkCreateV2RequestSchema>

export const SHARE_LINK_SCOPES = ['session', 'task'] as const
/** A link as the person's page lists it (v1 links too): the v1 fields, its protocol, its scope, and how many of its
 *  sessions are not deleted now (a session link: 1 or 0). */
export const ShareLinkV2Schema = z.strictObject({
  ...ShareLinkSchema.shape,
  protocol: z.union([z.literal(1), z.literal(2)]),
  scope: z.enum(SHARE_LINK_SCOPES),
  members: z.number().int().nonnegative(),
})
export type ShareLinkV2 = z.infer<typeof ShareLinkV2Schema>
/** GET /api/sessions/:session_id/share-links/v2 — the session's own links and the task links of its task, newest first. */
export const ShareLinkV2ListResponseSchema = z.strictObject({ links: z.array(ShareLinkV2Schema) })
export type ShareLinkV2ListResponse = z.infer<typeof ShareLinkV2ListResponseSchema>
/** POST /api/sessions/:session_id/share-links/v2 and POST /api/share-links/:id/v2/reveal. */
export const ShareLinkV2SecretResponseSchema = z.strictObject({ link: ShareLinkV2Schema, capability: z.string().regex(LIVE_CAPABILITY), url: z.string().nullable() })
export type ShareLinkV2SecretResponse = z.infer<typeof ShareLinkV2SecretResponseSchema>
/** POST /api/share-links/:id/v2/revoke. */
export const ShareLinkV2RevokeResponseSchema = z.strictObject({ link: ShareLinkV2Schema })
export type ShareLinkV2RevokeResponse = z.infer<typeof ShareLinkV2RevokeResponseSchema>

/** A live run with the face its turn wears (contract bots.ts turnFaceOf). */
export const LiveRunV2Schema = z.strictObject({ ...LiveRunSchema.shape, bot: z.enum(SHARE_BOTS).nullable(), enclosed: z.boolean() })
export type LiveRunV2 = z.infer<typeof LiveRunV2Schema>

/** One session of a v2 state. Its key (`s1`, …) stays the same for as long as its projection lives (a new epoch may
 *  give new keys); its images are its own (a resource is served for this session only). */
export const LiveSessionV2Schema = z.strictObject({
  key: Key,
  title: z.string(),
  /** a session that joined the task (the rail indents it) */
  member: z.boolean(),
  /** work is under way in it now */
  active: z.boolean(),
  bots: z.array(z.enum(SHARE_BOTS)),
  session: z.strictObject({ created_at: Time, last_activity_at: Time, model_label: z.string() }),
  participants: z.array(ShareParticipantSchema),
  runs: z.array(LiveRunV2Schema),
  items: z.array(LiveItemSchema),
  images: z.array(LiveImageRefSchema),
  team: ShareTeamSchema,
  stats: ShareStatsSchema,
})
export type LiveSessionV2 = z.infer<typeof LiveSessionV2Schema>

const LiveLimitsV2 = z.strictObject(Object.fromEntries([...Object.keys(SHARE_LIMITS), ...Object.keys(LIVE_SHARE_LIMITS_V2)].map((k) => [k, z.number().int()])) as
  Record<keyof typeof SHARE_LIMITS | keyof typeof LIVE_SHARE_LIMITS_V2, z.ZodNumber>)

export const LiveSnapshotV2Schema = z.strictObject({
  format: z.literal(LIVE_SHARE_FORMAT),
  version: z.literal(LIVE_SHARE_VERSION_V2),
  generated_at: z.string(),
  /** the current session's title */
  title: z.string(),
  scope: z.enum(SHARE_LINK_SCOPES),
  /** the session shown first: the task's first session while it is not deleted, else the first of the list — the same
   *  for every link of the task (the session a link was made from is the frame's `start`) */
  current: Key,
  options: z.strictObject({ include_tool_details: z.boolean(), include_images: z.boolean(), include_task_sessions: z.boolean() }),
  /** every session not deleted, in the rail's order */
  sessions: z.array(LiveSessionV2Schema).min(1),
  limits: LiveLimitsV2,
}).superRefine((s, ctx) => {
  const keys = new Set<string>()
  const resources = new Set<string>()
  for (const session of s.sessions) {
    if (keys.has(session.key)) ctx.addIssue({ code: 'custom', message: `session key ${session.key} repeated` })
    keys.add(session.key)
    const own = new Set(session.images.map((i) => i.resource))
    for (const r of own) { if (resources.has(r)) ctx.addIssue({ code: 'custom', message: 'an image resource of two sessions' }); resources.add(r) }
    for (const item of session.items) if (item.kind === 'image' && item.image !== null && !own.has(item.image)) ctx.addIssue({ code: 'custom', message: `session ${session.key}: an image of no ref of this session` })
    const runs = new Set(session.runs.map((r) => r.key))
    for (const row of session.team.rows) if (row.turn !== null && !runs.has(row.turn)) ctx.addIssue({ code: 'custom', message: `session ${session.key}: team row ${row.key} names no run of this session` })
  }
  if (!keys.has(s.current)) ctx.addIssue({ code: 'custom', message: '`current` names no session of the state' })
  if (s.scope === 'session' && s.sessions.length !== 1) ctx.addIssue({ code: 'custom', message: 'a session link shows one session' })
})
export type LiveSnapshotV2 = z.infer<typeof LiveSnapshotV2Schema>

/** SSE `event: state` of a v2 link. `start`: the session the link was made from (its key in this state), null once it
 *  is deleted — per link, so links of one task made from different sessions share one projection. */
export const LiveStateFrameV2Schema = z.strictObject({
  epoch: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
  revision: z.number().int().positive(),
  expires_at: z.string(),
  start: Key.nullable(),
  snapshot: LiveSnapshotV2Schema,
})
export type LiveStateFrameV2 = z.infer<typeof LiveStateFrameV2Schema>
/** What a viewer of today reads: a v1 link's frame or a v2 link's (by the snapshot's version). */
export const LiveStateFrameAnySchema = z.union([LiveStateFrameSchema, LiveStateFrameV2Schema])
export type LiveStateFrameAny = z.infer<typeof LiveStateFrameAnySchema>

/** SSE `event: ended` of a v2 link: v1's reasons and `busy` — the listener cannot hold the whole task now (its
 *  projection budget); not permanent: the viewer tries again later. A v1 stream never says `busy`. */
export const LIVE_ENDED_REASONS_V2 = [...LIVE_ENDED_REASONS, 'busy'] as const
export const LiveEndedFrameV2Schema = z.strictObject({ reason: z.enum(LIVE_ENDED_REASONS_V2) })
export type LiveEndedFrameV2 = z.infer<typeof LiveEndedFrameV2Schema>

/** One session of a v2 state in v1's snapshot shape (its runs without their faces), for the v1 thread renderer. */
export function liveSessionAsV1(snapshot: LiveSnapshotV2, key: string): LiveSnapshot | null {
  const s = snapshot.sessions.find((x) => x.key === key)
  if (!s) return null
  return {
    format: LIVE_SHARE_FORMAT, version: LIVE_SHARE_VERSION, generated_at: snapshot.generated_at, title: s.title,
    session: { ...s.session, active: s.active },
    options: { include_tool_details: snapshot.options.include_tool_details, include_images: snapshot.options.include_images },
    participants: s.participants, runs: s.runs.map(({ bot: _bot, enclosed: _enclosed, ...run }) => run), items: s.items, images: s.images, stats: s.stats,
    limits: Object.fromEntries(Object.keys(SHARE_LIMITS).map((k) => [k, snapshot.limits[k as keyof typeof SHARE_LIMITS]])) as LiveSnapshot['limits'],
  }
}
