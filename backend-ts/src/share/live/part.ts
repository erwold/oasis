/** One session's part of a live state v2 (contract/src/live_share.ts LiveSessionV2): the session projected by the
 *  snapshot's own code (share/snapshot.ts projectShareSession: the same whitelist, sanitizer — over every folder of its
 *  task — and sensitive-source rules as the live state v1), with its Agent Teams card, its turns' faces and the rail's
 *  bots (share/team.ts). A part is the same bytes whatever frame it is in — a link of the session alone or a link of its
 *  task — so it carries no key of the frame's: the frame gives it its key (`s1`, …) when it is put in. Everything here
 *  runs in the projector worker, on its own read-only connection. */

import { LIVE_SHARE_LIMITS_V2, LiveSessionV2Schema, type LiveSessionV2, type LiveSnapshot } from '@oasis-code/contract'
import { createHash } from 'node:crypto'
import * as repo from '../../db/repo.ts'
import { HttpError } from '../../api/state.ts'
import { freshBudget, projectShareSession, type LiveInput, type LiveOptions, type ShareSource } from '../snapshot.ts'
import { facedRuns } from '../task.ts'

/** The placeholder key a part is checked with (the frame puts its own in its place). */
const PART_KEY = 's0'
const PART_HEAD = `{"key":"${PART_KEY}",`

export interface BuiltPart {
  part: LiveSessionV2
  /** resource id → asset id: the pictures this part may serve */
  images: Map<string, string>
}

/** The session's part, read at one cut. Throws HttpError 404 for a session that is gone. */
export function buildLivePart(src: ShareSource, sessionId: string, options: LiveOptions, live: LiveInput, rowKeys: Map<string, string>, now: () => Date = () => new Date()): BuiltPart {
  return src.conn.transaction(() => {
    const session = repo.getSession(src.conn, sessionId)
    if (session === null || session.status === repo.DELETED_SESSION) throw new HttpError(404, 'session not found')
    const req = { include_tool_details: options.include_tool_details, include_images: options.include_images, exclude_run_ids: [...options.exclude_run_ids] }
    const res = projectShareSession(src, session, req, now, live, { budget: freshBudget(), rowKeys })
    if (!('images' in res) || res.extra === undefined || res.images === undefined) throw new Error('live part: no v2 extras')
    const snap = res.snapshot as LiveSnapshot
    const part: LiveSessionV2 = {
      key: PART_KEY, title: snap.title, member: (session.task_root_id ?? session.id) !== session.id, active: snap.session.active, bots: res.extra.bots,
      session: { created_at: snap.session.created_at, last_activity_at: snap.session.last_activity_at, model_label: snap.session.model_label },
      participants: snap.participants, runs: facedRuns(snap.runs, res.extra), items: snap.items, images: snap.images, team: res.extra.team, stats: snap.stats,
    }
    return { part, images: res.images }
  })
}

const encoder = new TextEncoder()

/** A part that does not fit its bound even without items and card rows: refused (the projection is busy), never cut
 *  further and never sent with a session missing. */
export class PartTooLarge extends Error { constructor() { super('the live part does not fit its bound even without items or card rows'); this.name = 'PartTooLarge' } }

/** The checked part as UTF-8 JSON without its key (`{` + the rest: the frame writes `{"key":"sN",` before it), within
 *  `max` bytes (LIVE_SHARE_LIMITS_V2.max_part_bytes): past it the latest items are dropped (stats.items_truncated), then
 *  the card's last rows (team.truncated); a part that does not fit even so is an error, never sent. */
export function serializePart(part: LiveSessionV2, max: number = LIVE_SHARE_LIMITS_V2.max_part_bytes): { bytes: Uint8Array; hash: string; truncated: boolean } {
  const checked = LiveSessionV2Schema.parse(part)
  const encode = (p: LiveSessionV2) => {
    const text = JSON.stringify({ ...p, key: PART_KEY })
    if (!text.startsWith(PART_HEAD)) throw new Error('live part: its key is not first')
    const bytes = encoder.encode(`{${text.slice(PART_HEAD.length)}`)
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex') }
  }
  const first = encode(checked)
  if (first.bytes.length <= max) return { ...first, truncated: false }
  const fit = (n: number, make: (k: number) => LiveSessionV2): { bytes: Uint8Array; hash: string } | null => {
    let lo = 0, hi = n, best: { bytes: Uint8Array; hash: string } | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const out = encode(make(mid))
      if (out.bytes.length <= max) { best = out; lo = mid + 1 } else hi = mid - 1
    }
    return best
  }
  const stats = { ...checked.stats, items_truncated: true }
  const byItems = fit(checked.items.length, (k) => ({ ...checked, items: checked.items.slice(0, k), stats }))
  if (byItems !== null) return { ...byItems, truncated: true }
  const rows = checked.team.rows
  const byRows = fit(rows.length, (k) => {
    const kept = new Set(rows.slice(0, k).map((r) => r.key))
    const team = { ...checked.team, truncated: true, rows: rows.slice(0, k).map((r) => ({ ...r, parent: r.parent !== null && kept.has(r.parent) ? r.parent : null, depends_on: r.depends_on.filter((d) => kept.has(d)) })) }
    return { ...checked, items: [], stats, team }
  })
  if (byRows !== null) return { ...byRows, truncated: true }
  throw new PartTooLarge()
}

/** A part's bytes with the frame's key for it. */
export function keyedPart(bytes: Uint8Array, key: string): Uint8Array[] {
  return [encoder.encode(`{"key":${JSON.stringify(key)},`), bytes.subarray(1)]
}
