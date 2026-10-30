/** The watches as the page shows them: what the session's agent is waiting for (a time, a command's end, a line or a
 *  number in its output, silence), what reported and waits for the conversation to be free, and whether the
 *  harness's latest word on them differs from the page's. */

import type { RunTreeRow, WakeEvent, Watch } from '../api/types'
import { nameOf } from './outline.ts'

type WithWatches = { watches?: Watch[]; wake_events?: WakeEvent[] } | null | undefined

/** The watches still waiting, oldest first (the order they were set). */
export function waitingWatches(session: WithWatches): Watch[] {
  return [...(session?.watches ?? [])].filter((w) => w.status === 'active').reverse()
}

/** Reports recorded and not yet delivered: the conversation was busy (the person's run, an interaction) or the
 *  hour's wakes were spent. */
export function undeliveredReports(session: WithWatches): WakeEvent[] {
  return (session?.wake_events ?? []).filter((e) => e.status === 'pending')
}

type NamedRow = Pick<RunTreeRow, 'id' | 'label' | 'user_text_head' | 'participant_alias'> & { collab?: RunTreeRow['collab']; spawned_by?: string | null; work_order?: RunTreeRow['work_order'] }

/** Who waits: the agents that set the watches (or whose watches reported), each once, in order, named as their cards
 *  are — a group member by its own id, any other agent as the outline names it. */
export function watchOwners(runIds: readonly string[], rows: readonly NamedRow[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const names: string[] = []
  for (const id of runIds) {
    const row = byId.get(id)
    const name = row ? row.participant_alias || nameOf(row) : null
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** The run that set a report's watch. */
export function reportRuns(reports: readonly WakeEvent[], session: WithWatches): string[] {
  const watches = new Map((session?.watches ?? []).map((w) => [w.id, w.run_id]))
  return reports.map((e) => watches.get(e.watch_id)).filter((id): id is string => !!id)
}

/** Whether the harness's watches differ from the page's: one set, reported, ended, cancelled; an event delivered. */
export function watchesChanged(known: WithWatches, fresh: WithWatches): boolean {
  const key = (s: WithWatches) => [
    ...(s?.watches ?? []).map((w) => `${w.id}:${w.status}:${w.fires}`),
    ...(s?.wake_events ?? []).map((e) => `${e.id}:${e.status}`),
  ].join(',')
  return key(known) !== key(fresh)
}

/** How long until a time, as a person reads it: "in 12 min", "in 3 h", "in 2 d"; "now" once it passed. */
export function untilLabel(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(at)) return ''
  const s = Math.round((at - now) / 1000)
  if (s <= 0) return 'now'
  if (s < 90) return `in ${s} s`
  if (s < 90 * 60) return `in ${Math.round(s / 60)} min`
  if (s < 36 * 3600) return `in ${Math.round(s / 3600)} h`
  return `in ${Math.round(s / 86400)} d`
}

/** The line a waiting watch shows: what it waits for; a timer, when. */
export function watchLabel(w: Watch, now = Date.now()): string {
  if (w.spec.kind === 'timer') {
    const due = w.fires === 0 ? w.spec.at : w.last_fired_at && w.spec.every_s ? new Date(Date.parse(w.last_fired_at) + w.spec.every_s * 1000).toISOString() : w.spec.at
    return `${w.spec.every_s ? `every ${Math.round(w.spec.every_s / 60)} min` : 'timer'} · ${untilLabel(due, now)}`
  }
  return w.summary
}
