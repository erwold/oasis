/** The frozen formats stay as commit 95dfa2f had them: the offline snapshot V1 / V2 and the live state v1 — their
 *  fields, their shared enums and limits (V2 and live v1 read SHARE_LIMITS' keys, every share reads the stats' and the
 *  run's) — and the v1 link's shapes. The lists below are the baseline's, written out here as data (no git read). V3
 *  and live v2 are separate exports and never change these. */

import { expect, test } from 'bun:test'
import {
  LIVE_ENDED_REASONS, LIVE_PERMANENT_END, LIVE_SHARE_FORMAT, LIVE_SHARE_LIMITS, LIVE_SHARE_VERSION, LiveRunSchema, LiveSnapshotSchema, LiveStateFrameSchema,
  SHARE_AUTHORS, SHARE_FORMAT, SHARE_IMAGE_OMISSIONS, SHARE_IMAGE_ORIGINS, SHARE_LIMITS, SHARE_LIMITS_V1_KEYS, SHARE_NOTICE_CODES, SHARE_OMISSION_KEYS, SHARE_REDACTION_KEYS,
  SHARE_RUN_STATUSES, SHARE_VERSION, SHARE_VERSION_V1, ShareLinkCreateRequestSchema, ShareLinkOptionsSchema, ShareLinkSchema, ShareParticipantSchema, ShareRunSchema,
  ShareSnapshotRequestSchema, ShareSnapshotResponseSchema, ShareSnapshotSchema, ShareSnapshotV1Schema, ShareSnapshotV2Schema, ShareStatsSchema,
} from '@oasis-code/contract'

const keys = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort()

const LIMIT_KEYS = ['max_items', 'max_text_chars', 'max_total_text_chars', 'max_tool_preview_chars', 'max_images', 'max_image_bytes', 'max_total_image_bytes',
  'max_image_side', 'max_image_pixels', 'max_excluded_runs', 'max_history_bytes', 'max_total_history_bytes']

test('offline V1 / V2: versions, fields, limits, enums as the baseline had them', () => {
  expect(SHARE_FORMAT).toBe('oasis-code.session-share')
  expect(SHARE_VERSION).toBe(2)
  expect(SHARE_VERSION_V1).toBe(1)
  expect(Object.keys(SHARE_LIMITS) as string[]).toEqual(LIMIT_KEYS)
  expect([...SHARE_LIMITS_V1_KEYS] as string[]).toEqual(LIMIT_KEYS)
  expect(SHARE_LIMITS).toEqual({ max_items: 5_000, max_text_chars: 200_000, max_total_text_chars: 4_000_000, max_tool_preview_chars: 2_000, max_images: 40,
    max_image_bytes: 5 * 1024 * 1024, max_total_image_bytes: 20 * 1024 * 1024, max_image_side: 8_000, max_image_pixels: 16_777_216, max_excluded_runs: 500,
    max_history_bytes: 32 * 1024 * 1024, max_total_history_bytes: 128 * 1024 * 1024 })
  const top = ['format', 'version', 'generated_at', 'title', 'session', 'options', 'participants', 'runs', 'items', 'images', 'stats', 'limits'].sort()
  expect(keys(ShareSnapshotV1Schema)).toEqual(top)
  expect(keys(ShareSnapshotV2Schema)).toEqual(top)
  expect(Object.keys((ShareSnapshotV2Schema.shape.limits as unknown as { shape: Record<string, unknown> }).shape)).toEqual(LIMIT_KEYS)
  expect(keys(ShareRunSchema)).toEqual(['key', 'parent', 'continues', 'participant', 'role', 'surface', 'group', 'started_by', 'request', 'client', 'label', 'model_label',
    'status', 'status_label', 'started_at', 'finished_at', 'error'].sort())
  expect(keys(ShareParticipantSchema)).toEqual(['key', 'role', 'label', 'model_label'].sort())
  expect([...SHARE_RUN_STATUSES]).toEqual(['done', 'cancelled', 'error'])
  expect([...SHARE_AUTHORS]).toEqual(['person', 'director', 'connector', 'agent', 'assistant', 'unattributed'])
  expect([...SHARE_IMAGE_ORIGINS]).toEqual(['attachment', 'screenshot', 'generated'])
  expect([...SHARE_IMAGE_OMISSIONS]).toEqual(['images_off', 'missing', 'damaged', 'unsupported', 'over_budget'])
  expect([...SHARE_NOTICE_CODES]).toEqual(['context_compacted', 'woken_by_watch', 'recorded_action', 'run_failed', 'run_stopped', 'history_unavailable'])
  expect([...SHARE_OMISSION_KEYS]).toEqual(['thinking', 'app_notes', 'compaction_summaries', 'system_prompts', 'retry_prompts', 'unknown_parts', 'tool_details',
    'sensitive_tool_content', 'ui_surfaces', 'ui_inputs', 'runs_excluded', 'images_off', 'images_missing', 'images_damaged', 'images_unsupported', 'images_over_budget',
    'images_workspace_files', 'histories_unreadable', 'histories_over_budget'])
  expect([...SHARE_REDACTION_KEYS]).toEqual(['session_token', 'private_key', 'auth_header', 'credential_url', 'secret_pattern', 'credential_assignment', 'path', 'username', 'email', 'invisible_chars'])
  expect(keys(ShareStatsSchema)).toEqual(['omitted', 'redacted', 'truncated_fields', 'items_truncated'].sort())
  expect(keys(ShareSnapshotRequestSchema)).toEqual(['include_tool_details', 'include_images', 'exclude_run_ids'].sort())
  // the frozen route answers V2 only; a V1|V2 reader refuses a V3
  expect(keys(ShareSnapshotResponseSchema)).toEqual(['selection', 'snapshot'])
  expect(ShareSnapshotResponseSchema.shape.snapshot).toBe(ShareSnapshotV2Schema)
  expect(ShareSnapshotSchema.safeParse({ format: SHARE_FORMAT, version: 3 }).success).toBe(false)
  const itemKinds = (ShareSnapshotV2Schema.shape.items as unknown as { element: { options: { shape: { kind: { value: string } } }[] } }).element.options.map((o) => o.shape.kind.value)
  expect(itemKinds).toEqual(['message', 'tool', 'director_note', 'group', 'image', 'notice', 'action', 'group_note'])
})

test('live v1: version, state, frames, ends, limits and link shapes as the baseline had them', () => {
  expect(LIVE_SHARE_FORMAT).toBe('oasis-code.session-live')
  expect(LIVE_SHARE_VERSION).toBe(1)
  expect(keys(LiveSnapshotSchema)).toEqual(['format', 'version', 'generated_at', 'title', 'session', 'options', 'participants', 'runs', 'items', 'images', 'stats', 'limits'].sort())
  expect(Object.keys((LiveSnapshotSchema.shape.limits as unknown as { shape: Record<string, unknown> }).shape)).toEqual(LIMIT_KEYS)
  expect(keys(LiveSnapshotSchema.shape.session as never)).toEqual(['created_at', 'last_activity_at', 'model_label', 'active'].sort())
  expect(keys(LiveRunSchema)).toEqual(keys(ShareRunSchema))
  expect(keys(LiveStateFrameSchema)).toEqual(['epoch', 'revision', 'expires_at', 'snapshot'].sort())
  expect([...LIVE_ENDED_REASONS]).toEqual(['revoked', 'expired', 'session_deleted', 'disabled', 'server_closing'])
  expect([...LIVE_PERMANENT_END]).toEqual(['revoked', 'expired', 'session_deleted'])
  expect(LIVE_SHARE_LIMITS).toEqual({ min_expiry_s: 300, max_expiry_s: 30 * 24 * 3600, default_expiry_s: 24 * 3600, max_active_links_per_session: 20, max_projections: 8,
    max_viewers_per_link: 25, max_viewers_total: 100, max_state_bytes: 16 * 1024 * 1024, heartbeat_ms: 15_000, max_label_chars: 120 })
  expect(keys(ShareLinkSchema)).toEqual(['id', 'session_id', 'label', 'options', 'created_at', 'expires_at', 'revoked_at', 'revoked_reason', 'state', 'viewers'].sort())
  expect(keys(ShareLinkOptionsSchema)).toEqual(['include_tool_details', 'include_images', 'exclude_run_ids'].sort())
  expect(keys(ShareLinkCreateRequestSchema)).toEqual(['label', 'expires_in_s', 'include_tool_details', 'include_images', 'exclude_run_ids'].sort())
  // a v1 frame refuses a v2 state
  expect(LiveStateFrameSchema.safeParse({ epoch: 'abcdefgh', revision: 1, expires_at: 'x', snapshot: { format: LIVE_SHARE_FORMAT, version: 2 } }).success).toBe(false)
})
