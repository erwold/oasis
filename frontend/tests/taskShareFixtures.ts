/** Synthetic V3 shares and v2 live states (contract share.ts, live_share.ts, agent_teams.ts): a task of two sessions,
 *  each with its own runs, its own picture under the SAME image key (`img1`), its own Agent Teams card and rail bots.
 *  No real session, id, capability or secret. */
import {
  LIVE_SHARE_FORMAT, LIVE_SHARE_LIMITS_V2, LIVE_SHARE_VERSION_V2, LiveStateFrameV2Schema, SHARE_FORMAT, SHARE_LIMITS, SHARE_LIMITS_V3, SHARE_OMISSION_KEYS,
  SHARE_REDACTION_KEYS, SHARE_VERSION_V3, ShareSnapshotV3Schema,
  type LiveSessionV2, type LiveStateFrameV2, type ShareItemV2, type ShareRunV3, type ShareSessionV3, type ShareSnapshotV3, type ShareTeam, type ShareTeamRow,
} from '@oasis-code/contract'
import { imageRef, liveRun, RES_A, RES_B } from './liveShareFixtures.ts'

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>
export const STATS = () => ({ omitted: zero(SHARE_OMISSION_KEYS), redacted: zero(SHARE_REDACTION_KEYS), truncated_fields: 0, items_truncated: false })

/** A 1×1 PNG and another (a different pixel), base64. */
export const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
export const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export const teamRow = (over: Partial<ShareTeamRow> & { key: string }): ShareTeamRow => ({
  parent: null, depends_on: [], kind: 'run', name: 'Agent', bot: '05-bubble', model_label: 'Model A', status: 'done', glyph: 'done', participant_index: null,
  participant_label: null, runs: 1, started_at: '2026-10-21T01:00:00.000Z', finished_at: '2026-10-21T01:05:00.000Z', turn: null, ...over,
})

/** The card of a director's plan: the main agent, a child it dispatched (running), the plan, a member the plan
 *  scheduled (its badge), a decision after it — and a row naming a parent the card does not hold. */
export function teamFixture(): ShareTeam {
  return {
    rows: [
      teamRow({ key: 't1', name: 'Main agent', bot: '20-at', turn: 'r1', runs: 2 }),
      teamRow({ key: 't2', parent: 't1', name: 'Child at work', bot: '13-puzzle', status: 'running', glyph: null, finished_at: null, turn: 'r2' }),
      teamRow({ key: 't3', kind: 'plan', name: 'Plan', bot: 'director', model_label: 'Model D', status: 'waiting', glyph: null, finished_at: null }),
      teamRow({ key: 't4', parent: 't3', name: 'Reviewer', bot: '29-lighthouse', participant_index: 0, participant_label: 'Reviewer', glyph: 'warn', turn: 'r2' }),
      teamRow({ key: 't5', parent: 't3', kind: 'decision', name: 'Your decision', bot: null, model_label: null, status: 'queued', glyph: null, depends_on: ['t4', 't9'], finished_at: null }),
      teamRow({ key: 't6', parent: 't8', name: 'Orphan', bot: '08-prompt', status: 'error', glyph: 'err' }),
    ],
    agents: 4, live: 2, truncated: false,
  }
}

const run3 = (over: Partial<ShareRunV3> & { key: string }): ShareRunV3 => ({
  parent: null, continues: null, participant: null, role: 'main', surface: 'thread', group: null, started_by: 'person', request: 'message', client: null,
  label: null, model_label: 'Model A', status: 'done', status_label: 'done', started_at: '2026-10-21T01:00:00.000Z', finished_at: '2026-10-21T01:05:00.000Z', error: null,
  bot: '20-at', enclosed: false, ...over,
})

function session(key: string, o: { title: string; member: boolean; current: boolean; bots: ShareSessionV3['bots']; answer: string; png: string; team?: ShareTeam }): ShareSessionV3 {
  const items: ShareItemV2[] = [
    { kind: 'message', key: 'i1', run: 'r1', at: '2026-10-21T01:00:00.000Z', author: 'person', author_label: 'Person', source: 'opening', text: `Question of ${o.title}`, steer: null },
    { kind: 'message', key: 'i2', run: 'r1', at: '2026-10-21T01:01:00.000Z', author: 'assistant', author_label: 'Agent', source: 'answer', text: o.answer, steer: null },
    { kind: 'tool', key: 'i3', run: 'r2', at: '2026-10-21T01:02:00.000Z', name: 'bash', status: 'ok', target: 'npm test', details: null, withheld: null },
    { kind: 'image', key: 'i4', run: 'r2', at: '2026-10-21T01:02:10.000Z', origin: 'generated', image: 'img1', omitted: null },
    { kind: 'message', key: 'i5', run: 'r2', at: '2026-10-21T01:03:00.000Z', author: 'assistant', author_label: 'Child', source: 'answer', text: `Child of ${o.title}`, steer: null },
  ]
  return {
    key, title: o.title, member: o.member, current: o.current, bots: o.bots,
    session: { created_at: '2026-10-21T00:59:00.000Z', last_activity_at: '2026-10-21T01:05:00.000Z', model_label: 'Model A' },
    participants: [],
    runs: [run3({ key: 'r1', label: 'Main run', bot: o.bots[0]! }), run3({ key: 'r2', parent: 'r1', role: 'child', request: 'child', started_by: 'agent', bot: '13-puzzle', enclosed: true })],
    items,
    images: [{ key: 'img1', media_type: 'image/png', width: 1, height: 1, bytes: atob(o.png).length, data_base64: o.png }],
    team: o.team ?? { rows: [teamRow({ key: 't1', name: 'Main agent', bot: o.bots[0]!, turn: 'r1' })], agents: 1, live: 0, truncated: false },
    stats: STATS(),
  }
}

/** A task's V3 snapshot: its first session (the one shared) and a member — each with its picture `img1`. */
export function taskSnapshot(over: Partial<ShareSnapshotV3> = {}): ShareSnapshotV3 {
  return ShareSnapshotV3Schema.parse({
    format: SHARE_FORMAT, version: SHARE_VERSION_V3, generated_at: '2026-10-21T02:00:00.000Z', title: 'Root session', scope: 'task', current: 's1',
    options: { include_tool_details: false, include_images: true, include_task_sessions: true },
    sessions: [
      session('s1', { title: 'Root session', member: false, current: true, bots: ['20-at', '13-puzzle', '29-lighthouse', '08-prompt'], answer: 'Root answer.', png: PNG_A, team: teamFixture() }),
      session('s2', { title: 'Member session', member: true, current: false, bots: ['02-terminal'], answer: 'Member answer.', png: PNG_B }),
    ],
    stats: STATS(),
    limits: { ...SHARE_LIMITS_V3 },
    ...over,
  })
}

// ---- v2 live states ---------------------------------------------------------------------------------------------

function liveSession(key: string, o: { title: string; member: boolean; active: boolean; resource: string; bots: LiveSessionV2['bots']; answer: string; team?: ShareTeam }): LiveSessionV2 {
  return {
    key, title: o.title, member: o.member, active: o.active, bots: o.bots,
    session: { created_at: '2026-10-22T00:59:00.000Z', last_activity_at: '2026-10-22T01:06:50.000Z', model_label: 'Model A' },
    participants: [],
    runs: [{ ...liveRun({ key: 'r1' }), bot: o.bots[0]!, enclosed: false }, { ...liveRun({ key: 'r2', status: o.active ? 'running' : 'done', finished_at: o.active ? null : '2026-10-22T01:05:00.000Z' }), bot: '13-puzzle', enclosed: true }],
    items: [
      { kind: 'message', key: 'i1', run: 'r1', at: '2026-10-22T01:00:00.000Z', author: 'person', author_label: 'Person', source: 'opening', text: `Question of ${o.title}`, steer: null },
      { kind: 'message', key: 'i2', run: 'r1', at: '2026-10-22T01:01:00.000Z', author: 'assistant', author_label: 'Model A', source: 'answer', text: o.answer, steer: null },
      { kind: 'tool', key: 'i3', run: 'r2', at: '2026-10-22T01:02:00.000Z', name: 'bash', status: 'ok', target: 'npm test', details: null, withheld: null },
      { kind: 'image', key: 'i4', run: 'r2', at: '2026-10-22T01:02:10.000Z', origin: 'generated', image: o.resource, omitted: null },
    ],
    images: [imageRef(o.resource)],
    team: o.team ?? { rows: [teamRow({ key: 't1', name: 'Main agent', bot: o.bots[0]!, turn: 'r1', status: o.active ? 'running' : 'done', glyph: o.active ? null : 'done', finished_at: o.active ? null : '2026-10-22T01:05:00.000Z' })], agents: 1, live: o.active ? 1 : 0, truncated: false },
    stats: STATS(),
  }
}

export const LIVE_S1 = () => liveSession('s1', { title: 'Live root', member: false, active: true, resource: RES_A, bots: ['20-at', '13-puzzle'], answer: 'Live root answer.', team: teamFixture() })
export const LIVE_S2 = () => liveSession('s2', { title: 'Live member', member: true, active: false, resource: RES_B, bots: ['02-terminal'], answer: 'Live member answer.' })

export function taskFrame(over: Partial<LiveStateFrameV2> = {}, sessions: LiveSessionV2[] = [LIVE_S1(), LIVE_S2()], current = 's1'): LiveStateFrameV2 {
  return LiveStateFrameV2Schema.parse({
    epoch: 'epochAAAA', revision: 1, expires_at: '2026-10-23T01:00:00.000Z', start: 's2',
    snapshot: {
      format: LIVE_SHARE_FORMAT, version: LIVE_SHARE_VERSION_V2, generated_at: '2026-10-22T01:07:00.000Z', title: 'Live root', scope: 'task', current,
      options: { include_tool_details: false, include_images: true, include_task_sessions: true }, sessions,
      limits: { ...SHARE_LIMITS, ...LIVE_SHARE_LIMITS_V2 },
    },
    ...over,
  })
}
