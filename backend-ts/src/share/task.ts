/** The session share's V3 (contract/src/share.ts): one session, or every session of its task that is not deleted —
 *  by task relation only (repo.sessionsOfTask: the task's first session and every session that joined it, any
 *  project), never a part of them — each with its Agent Teams card, its turns' faces and the rail's bots, all read at
 *  one cut (one read transaction), every session projected by the snapshot's own code with its own sanitizer (over the
 *  folders of every session of the task), its own pictures (its own attachment assets only) and the snapshot's
 *  budgets shared by all of them. A task too large is refused whole. */

import {
  SHARE_FORMAT, SHARE_LIMITS_V3, SHARE_OMISSION_KEYS, SHARE_REDACTION_KEYS, SHARE_VERSION_V3, type Session, type ShareSessionV3, type ShareSnapshotV3,
  type ShareBot, type ShareSnapshotV3Request, type ShareSnapshotV3Response, type ShareStats,
} from '@oasis-code/contract'
import * as repo from '../db/repo.ts'
import type { ProgressSamples } from './progress.ts'
import type { Conn } from '../db/database.ts'
import { requireSession, type AppState } from '../api/state.ts'
import { activeWork, appShareSource, freshBudget, projectShareSession, ShareActive, type ProjectedExtra } from './snapshot.ts'

/** The share is past one of V3's whole-share bounds (max_sessions, max_snapshot_bytes): refused, never cut. */
export class ShareTooLarge extends Error {
  constructor(message: string) { super(message); this.name = 'ShareTooLarge' }
}

const stamp = (t: string | null | undefined): number => (t ? Date.parse(t) || 0 : 0)

/** The rail's order of a task's sessions (frontend state/rail.ts railGroups): its first session, while it is not
 *  deleted, then the others by their latest activity (last_activity_at, else updated_at), newest first, then by when
 *  they were made, newest first, then by id. */
export function railOrder<S extends Pick<Session, 'id' | 'created_at' | 'updated_at' | 'last_activity_at'>>(sessions: readonly S[], rootId: string): S[] {
  const root = sessions.find((s) => s.id === rootId)
  const others = sessions.filter((s) => s.id !== rootId).sort((a, b) =>
    stamp(b.last_activity_at ?? b.updated_at) - stamp(a.last_activity_at ?? a.updated_at) || stamp(b.created_at) - stamp(a.created_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  return root ? [root, ...others] : others
}

/** The task a session belongs to (its first session's id: its own when it is the first). */
export const taskRootOf = (session: Pick<Session, 'id' | 'task_root_id'>): string => session.task_root_id ?? session.id

/** The sessions of a task that are not deleted, in the rail's order. */
export function taskSessions(conn: Conn, rootId: string): Session[] {
  return railOrder(repo.sessionsOfTask(conn, rootId), rootId)
}

function addStats(into: ShareStats, s: ShareStats): void {
  for (const k of SHARE_OMISSION_KEYS) into.omitted[k] += s.omitted[k]
  for (const k of SHARE_REDACTION_KEYS) into.redacted[k] += s.redacted[k]
  into.truncated_fields += s.truncated_fields
  into.items_truncated ||= s.items_truncated
}
export const emptyStats = (): ShareStats => ({
  omitted: Object.fromEntries(SHARE_OMISSION_KEYS.map((k) => [k, 0])) as ShareStats['omitted'],
  redacted: Object.fromEntries(SHARE_REDACTION_KEYS.map((k) => [k, 0])) as ShareStats['redacted'],
  truncated_fields: 0, items_truncated: false,
})

/** The run of a projection by its key, with its face (bots.ts turnFaceOf / botOf, by real run id) attached. */
export function facedRuns<R extends { key: string }>(runs: R[], extra: ProjectedExtra): (R & { bot: ShareBot | null; enclosed: boolean })[] {
  const idOfKey = new Map([...extra.runKey].map(([id, key]) => [key, id]))
  return runs.map((r) => {
    const face = extra.faces.get(idOfKey.get(r.key) ?? '') ?? { bot: null, enclosed: false }
    return { ...r, bot: face.bot, enclosed: face.enclosed }
  })
}

/** The same preflight before asynchronous sampling and again inside the projection transaction. */
export function shareMembers(state: AppState, sessionId: string, includeTaskSessions: boolean): { anchor: Session; root: string; members: Session[] } {
  const anchor = requireSession(state, sessionId)
  const root = taskRootOf(anchor)
  const members = includeTaskSessions ? taskSessions(state.conn, root) : [anchor]
  if (!members.some((m) => m.id === anchor.id)) members.unshift(anchor)
  if (members.length > SHARE_LIMITS_V3.max_sessions) {
    throw new ShareTooLarge(`the task has ${members.length} sessions; a share holds at most ${SHARE_LIMITS_V3.max_sessions} — share fewer (this session alone)`)
  }
  // only a quiescent share: every session of it at rest
  const reasons = members.flatMap((m) => activeWork(state, m.id).map((r) => (members.length > 1 ? `${m.title || 'a session'}: ${r}` : r)))
  if (reasons.length) throw new ShareActive(reasons)
  return { anchor, root, members }
}

/** The V3 snapshot and the dialog's run choice. Throws ShareActive while work is under way in any session shared,
 *  ShareTooLarge past max_sessions or max_snapshot_bytes. */
export function buildShareSnapshotV3(state: AppState, sessionId: string, req: ShareSnapshotV3Request, now: () => Date = () => new Date(), progressSamples?: ProgressSamples): ShareSnapshotV3Response {
  const src = { ...appShareSource(state), progressSamples }
  const answer = state.conn.transaction(() => {
    const { anchor, root, members } = shareMembers(state, sessionId, req.include_task_sessions)
    const keyOf = new Map(members.map((m, i) => [m.id, `s${i + 1}`]))
    // the budgets are the whole share's; the session shared first, then the rail's order
    const budget = freshBudget()
    const order = [anchor, ...members.filter((m) => m.id !== anchor.id)]
    const built = new Map<string, { entry: ShareSessionV3; selection: ShareSnapshotV3Response['selection']['runs'] }>()
    const shareReq = { include_tool_details: req.include_tool_details, include_images: req.include_images, exclude_run_ids: req.exclude_run_ids }
    for (const m of order) {
      const res = projectShareSession(src, m, shareReq, now, null, { budget })
      if (!('selection' in res) || res.extra === undefined) throw new Error('share projection: no V3 extras')
      const snap = res.snapshot
      const key = keyOf.get(m.id)!
      const entry: ShareSessionV3 = {
        key, title: snap.title, member: m.id !== root, current: m.id === anchor.id, bots: res.extra.bots, session: snap.session,
        participants: snap.participants, runs: facedRuns(snap.runs, res.extra), items: snap.items, images: snap.images, team: res.extra.team, stats: snap.stats,
      }
      built.set(m.id, { entry, selection: res.selection.runs.map((r) => ({ ...r, session: key })) })
    }
    const sessions = members.map((m) => built.get(m.id)!.entry)
    const stats = emptyStats()
    for (const s of sessions) addStats(stats, s.stats)
    const snapshot: ShareSnapshotV3 = {
      format: SHARE_FORMAT, version: SHARE_VERSION_V3, generated_at: now().toISOString(), title: built.get(anchor.id)!.entry.title,
      scope: req.include_task_sessions ? 'task' : 'session', current: keyOf.get(anchor.id)!,
      options: { include_tool_details: req.include_tool_details, include_images: req.include_images, include_task_sessions: req.include_task_sessions },
      sessions, stats, limits: { ...SHARE_LIMITS_V3 },
    }
    return { snapshot, selection: { runs: members.flatMap((m) => built.get(m.id)!.selection) } }
  })
  // the whole answer's bound, measured as it will be sent
  const bytes = Buffer.byteLength(JSON.stringify(answer))
  if (bytes > SHARE_LIMITS_V3.max_snapshot_bytes) throw new ShareTooLarge(`the share would be ${bytes} bytes; at most ${SHARE_LIMITS_V3.max_snapshot_bytes} — share fewer sessions or leave pictures out`)
  return answer
}
