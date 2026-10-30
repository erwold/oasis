/** Synthetic live link states (contract/src/live_share.ts): a session at work — a finished run, a running one with a
 *  running tool, an answer still being written (`message_open`), a queued steer — its pictures named by opaque
 *  resource ids. No real session, id, capability or secret. */
import {
  LIVE_SHARE_FORMAT, LIVE_SHARE_VERSION, LiveStateFrameSchema, SHARE_LIMITS, SHARE_OMISSION_KEYS, SHARE_REDACTION_KEYS,
  type LiveImageRef, type LiveItem, type LiveRun, type LiveSnapshot, type LiveStateFrame,
} from '@oasis-code/contract'

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>

/** a synthetic capability of the contract's shape (43 base64url characters) */
export const CAPABILITY = 'synthetic_capability_0123456789_ABCDEFGHIJK'.slice(0, 43)
export const RES_A = `m${'a'.repeat(24)}`
export const RES_B = `m${'b'.repeat(24)}`

export const liveRun = (over: Partial<LiveRun> & { key: string }): LiveRun => ({
  parent: null, continues: null, participant: null, role: 'main', surface: 'thread', group: null, started_by: 'person', request: 'message', client: null,
  label: null, model_label: 'Model A', status: 'done', status_label: 'Done', started_at: '2026-10-22T01:00:00.000Z', finished_at: '2026-10-22T01:05:00.000Z', error: null, ...over,
})

export const imageRef = (resource: string, over: Partial<LiveImageRef> = {}): LiveImageRef => ({ resource, media_type: 'image/png', width: 1, height: 1, bytes: 70, ...over })

export function liveSnapshot(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  const items: LiveItem[] = [
    { kind: 'message', key: 'i1', run: 'r1', at: '2026-10-22T01:00:00.000Z', author: 'person', author_label: 'Person', source: 'opening', text: 'Earlier question', steer: null },
    { kind: 'message', key: 'i2', run: 'r1', at: '2026-10-22T01:01:00.000Z', author: 'assistant', author_label: 'Model A', source: 'answer', text: 'Earlier answer.', steer: null },
    { kind: 'message', key: 'i3', run: 'r2', at: '2026-10-22T01:06:00.000Z', author: 'person', author_label: 'Person', source: 'opening', text: 'Now fix the build', steer: null },
    { kind: 'tool', key: 'i4', run: 'r2', at: '2026-10-22T01:06:10.000Z', name: 'bash', status: 'ok', target: 'npm test', details: null, withheld: null },
    { kind: 'image', key: 'i5', run: 'r2', at: '2026-10-22T01:06:20.000Z', origin: 'generated', image: RES_A, omitted: null },
    { kind: 'tool', key: 'i6', run: 'r2', at: '2026-10-22T01:06:30.000Z', name: 'bash', status: 'running', target: 'npm run build', details: null, withheld: null },
    { kind: 'message', key: 'i7', run: 'r2', at: '2026-10-22T01:06:40.000Z', author: 'person', author_label: 'Person', source: 'steer', text: 'queued words', steer: { status: 'queued', by: 'person', client: null, reason: null } },
    { kind: 'message_open', key: 'i8', run: 'r2', at: '2026-10-22T01:06:50.000Z', author: 'assistant', author_label: 'Model A', text: 'Working on it, first line done', withheld_tail: true },
  ]
  return {
    format: LIVE_SHARE_FORMAT, version: LIVE_SHARE_VERSION, generated_at: '2026-10-22T01:07:00.000Z', title: 'Synthetic live session',
    session: { created_at: '2026-10-22T00:59:00.000Z', last_activity_at: '2026-10-22T01:06:50.000Z', model_label: 'Model A', active: true },
    options: { include_tool_details: false, include_images: true },
    participants: [],
    runs: [liveRun({ key: 'r1' }), liveRun({ key: 'r2', status: 'running', status_label: 'Running', finished_at: null })],
    items,
    images: [imageRef(RES_A)],
    stats: { omitted: zero(SHARE_OMISSION_KEYS), redacted: zero(SHARE_REDACTION_KEYS), truncated_fields: 0, items_truncated: false },
    limits: { ...SHARE_LIMITS },
    ...over,
  }
}

export function liveFrame(over: Partial<LiveStateFrame> = {}, snapshot: Partial<LiveSnapshot> = {}): LiveStateFrame {
  return LiveStateFrameSchema.parse({ epoch: 'epochAAAA', revision: 1, expires_at: '2026-10-23T01:00:00.000Z', snapshot: liveSnapshot(snapshot), ...over })
}

/** an SSE `state` message of a frame, as the server writes it */
export const stateEvent = (frame: LiveStateFrame) => `event: state\nid: ${frame.epoch}.${frame.revision}\ndata: ${JSON.stringify(frame)}\n\n`
export const endedEvent = (reason: string) => `event: ended\ndata: ${JSON.stringify({ reason })}\n\n`

/** A 1×1 PNG (70 bytes). */
export const PNG_1X1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
