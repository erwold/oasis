/** The relations drawn as a timeline (Agent Teams → Relations): one lane per participant, each run a bar from when it
 *  began to when it ended, the dispatcher's lane over them, and the typed edges between runs as arrows — handed over,
 *  cited, ran after, dispatched. Idle stretches longer than GAP_MS are drawn as a short break, so a session that rested
 *  for hours still reads in one width. Pure: the component only draws what this returns. */

import type { CollabEdge, CollabGroup, CollabNode, CollabRun, CollaborationGraph, Participant } from '@oasis-code/contract'

export const LANE_H = 30
export const BAR_H = 14
export const AXIS_H = 22
export const GAP_MS = 5 * 60_000
export const GAP_PX = 18
const PAD_X = 10
/** A board of more lanes than this folds its settled agents into one row (the row opens them again) */
export const FOLD_LANES_ABOVE = 12
/** An agent is settled when its last run ended this long before now, nothing of it runs, no step waits for it and no
 *  watch it set is still waiting */
export const SETTLED_MS = 30 * 60_000

export type LinkKind = 'received' | 'cited' | 'after' | 'dispatched' | 'continues'
export const LINK_KINDS: LinkKind[] = ['received', 'cited', 'dispatched', 'after', 'continues']

export interface Lane {
  id: string
  kind: 'dispatcher' | 'participant' | 'hand' | 'settled'
  label: string
  sub: string
  /** the participant whose bot the lane wears (null: the dispatcher's lane, the by-hand lane) */
  participant_id: string | null
  role: string | null
  group_id: string | null
  y: number
  /** the settled row: how many agents it holds */
  count?: number
}

export interface Bar {
  run: CollabRun
  lane: string
  x0: number
  x1: number
  y: number
  /** what the bar says inside when it is wide enough: its step, else nothing */
  tag: string | null
}

/** A clock after a lane's last bar: what that lane's agent still waits on (its watches set), one line each. */
export interface WatchMark { lane: string; x: number; y: number; labels: string[] }

/** Where the watches still set go: after the last bar of the lane of the run that set each (a lane whose run is not
 *  on this timeline gets none). */
export function watchMarks(bars: Bar[], watches: { run_id: string; label: string }[]): WatchMark[] {
  const laneOf = new Map(bars.map((b) => [b.run.id, b.lane]))
  const lastOf = new Map<string, Bar>()
  for (const b of bars) {
    const prev = lastOf.get(b.lane)
    if (!prev || b.x1 > prev.x1) lastOf.set(b.lane, b)
  }
  const marks = new Map<string, WatchMark>()
  for (const w of watches) {
    const lane = laneOf.get(w.run_id)
    if (lane === undefined) continue
    const mark = marks.get(lane)
    if (mark) { mark.labels.push(w.label); continue }
    const last = lastOf.get(lane)!
    marks.set(lane, { lane, x: last.x1, y: last.y, labels: [w.label] })
  }
  return [...marks.values()]
}

/** `lane_from`, `lane_to`: the lanes the arrow leaves and reaches (a settled agent's: the settled row) */
export interface Link { id: string; kind: LinkKind; from: { x: number; y: number }; to: { x: number; y: number }; run_from: string | null; run_to: string; lane_from: string; lane_to: string; chars: number | null }
export interface Tick { x: number; label: string; gap: boolean }

/** A step planned and not started: an empty slot at the end of its participant's lane, by its wave */
export interface Ghost { id: string; lane: string; x0: number; x1: number; y: number; tag: string }

/** Where the settled row's agents worked, merged into stretches */
export interface Span { x0: number; x1: number; y: number }

/** `settles_at`: when the next agent of a long board settles and its lane folds (the board is laid out again then);
 *  null when none will without a new graph */
export interface RelationsLayout { lanes: Lane[]; bars: Bar[]; ghosts: Ghost[]; spans: Span[]; settles_at: number | null; /** where now is while something runs (the playhead), else null */ now_x: number | null; links: Link[]; ticks: Tick[]; width: number; height: number; px_per_min: number }

const GHOST_W = 56

/** The session's agents as one board: every participant, the main agent among them, each with all its runs and the
 *  steps planned for it, and what was handed or cited between them; none while the main agent works alone. */
export function scopeToAgents(graph: CollaborationGraph): CollaborationGraph | null {
  const wanted = new Set(graph.participants.map((p) => p.id))
  const runs = graph.runs.filter((r) => r.collab.participant_id !== null && wanted.has(r.collab.participant_id))
  const ids = new Set(runs.map((r) => r.id))
  const nodes = graph.nodes.filter((n) => n.participant_id !== null && wanted.has(n.participant_id))
  const present = new Set<string | null>([...runs.map((r) => r.collab.participant_id), ...nodes.map((n) => n.participant_id)])
  if (!graph.participants.some((p) => p.role !== 'main' && present.has(p.id))) return null
  return {
    ...graph,
    participants: graph.participants.filter((p) => present.has(p.id)),
    runs,
    nodes,
    edges: graph.edges.filter((e) => e.to.kind === 'run' && ids.has(e.to.id) && (e.from.kind !== 'run' || ids.has(e.from.id))),
  }
}

/** The board's agents, each as its latest run stands: the main agent first, the rest in the order they first ran; and
 *  the board's line under it. */
export function boardAgents(graph: Pick<CollaborationGraph, 'participants' | 'runs'>): { participant: Participant; latest: CollabRun }[] {
  // a participant's first and latest run in one pass: the latest is the last of its runs by time (a tie: the later listed)
  const span = new Map<string, { first: CollabRun; latest: CollabRun }>()
  for (const r of graph.runs) {
    const pid = r.collab.participant_id
    if (pid === null) continue
    const s = span.get(pid)
    if (!s) { span.set(pid, { first: r, latest: r }); continue }
    if (r.created_at.localeCompare(s.first.created_at) < 0) s.first = r
    if (r.created_at.localeCompare(s.latest.created_at) >= 0) s.latest = r
  }
  return graph.participants.flatMap((participant) => {
    const s = span.get(participant.id)
    return s ? [{ participant, latest: s.latest, first: s.first.created_at }] : []
  }).sort((a, b) => (a.participant.role === 'main' ? 0 : 1) - (b.participant.role === 'main' ? 0 : 1) || a.first.localeCompare(b.first))
    .map(({ participant, latest }) => ({ participant, latest }))
}

/** The board's line: how many agents, and where their latest runs stand. A run queued (its turn not come) is said so,
 *  never counted as running, live or not; a live run otherwise runs, whatever an older status said. */
export function agentsLine(agents: { latest: Pick<CollabRun, 'status' | 'live'> }[]): string {
  const count = (pred: (s: string, live: boolean) => boolean) => agents.filter((a) => pred(a.latest.status, !!a.latest.live)).length
  const running = count((s, live) => s !== 'queued' && (live || s === 'running'))
  const parts = [`${agents.length} agent${agents.length === 1 ? '' : 's'}`]
  if (running) parts.push(`${running} running`)
  const queued = count((s) => s === 'queued')
  if (queued) parts.push(`${queued} queued`)
  const done = count((s, live) => !live && s === 'done')
  if (done) parts.push(`${done} done`)
  const failed = count((s, live) => !live && s === 'error')
  if (failed) parts.push(`${failed} failed`)
  const stopped = count((s, live) => !live && s === 'cancelled')
  if (stopped) parts.push(`${stopped} stopped`)
  return parts.join(' · ')
}

const DIRECTING = new Set(['director', 'connector'])

const ms = (iso: string): number => Date.parse(iso)

/** A piecewise-linear clock: busy stretches at `pxPerMs`, idle ones longer than GAP_MS at GAP_PX. */
export function timeScale(intervals: [number, number][], widthHint: number): { x: (t: number) => number; width: number; pxPerMs: number; segments: { t0: number; t1: number; x0: number; gap: boolean }[] } {
  if (!intervals.length) return { x: () => PAD_X, width: PAD_X * 2, pxPerMs: 0, segments: [] }
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const busy: [number, number][] = []
  for (const [a, b] of sorted) {
    const last = busy[busy.length - 1]
    if (last && a <= last[1] + GAP_MS) last[1] = Math.max(last[1], b)
    else busy.push([a, Math.max(a, b)])
  }
  const busyMs = busy.reduce((n, [a, b]) => n + (b - a), 0) || 60_000
  const gaps = busy.length - 1
  // fill the width given, within reason: no slower than 1.5 px a minute, no faster than 24
  const pxPerMs = Math.min(24, Math.max(1.5, (widthHint - PAD_X * 2 - gaps * GAP_PX) / (busyMs / 60_000))) / 60_000
  const segments: { t0: number; t1: number; x0: number; gap: boolean }[] = []
  let x = PAD_X
  busy.forEach(([a, b], i) => {
    if (i > 0) { segments.push({ t0: busy[i - 1]![1], t1: a, x0: x, gap: true }); x += GAP_PX }
    segments.push({ t0: a, t1: b, x0: x, gap: false })
    x += (b - a) * pxPerMs
  })
  const at = (t: number): number => {
    if (t <= segments[0]!.t0) return PAD_X
    for (const s of segments) {
      if (t > s.t1) continue
      return s.gap ? s.x0 + ((t - s.t0) / Math.max(1, s.t1 - s.t0)) * GAP_PX : s.x0 + (t - s.t0) * pxPerMs
    }
    return x
  }
  return { x: at, width: x + PAD_X, pxPerMs, segments }
}

/** Whether a tick's words stand clear of the playhead's "now" over the same axis line: a clock label reads from 3 px
 *  past its mark for about 40 px, a break's "⋯ 2h" is centred on it; "now" is centred on the playhead, about 22 px
 *  wide. A tick whose words would touch it keeps its mark (a clock tick its line, a break its ⋯) and loses its words
 *  while now stands there. */
export function tickClearsNow(tick: { x: number; gap: boolean }, nowX: number | null): boolean {
  if (nowX === null) return true
  const [a, b] = tick.gap ? [tick.x - 20, tick.x + 20] : [tick.x, tick.x + 43]
  return b <= nowX - 14 || a >= nowX + 14
}

/** Clock ticks: the start of every busy stretch, then every `step` minutes inside it where there is room. */
function ticksOf(segments: { t0: number; t1: number; x0: number; gap: boolean }[], pxPerMs: number, clock: (t: number) => string): Tick[] {
  const ticks: Tick[] = []
  const stepMin = [5, 10, 15, 30, 60, 120].find((m) => m * 60_000 * pxPerMs >= 70) ?? 240
  const step = stepMin * 60_000
  // a label needs about 40 px: one that would touch the label before it is left out (a break keeps its mark, not its words)
  const room = (x: number): boolean => !ticks.length || x - ticks[ticks.length - 1]!.x >= 46
  for (const s of segments) {
    if (s.gap) { ticks.push({ x: s.x0 + GAP_PX / 2, label: room(s.x0 + GAP_PX / 2) ? `${Math.round((s.t1 - s.t0) / 60_000)}m` : '', gap: true }); continue }
    const last = ticks[ticks.length - 1]
    if (last?.gap && s.x0 - last.x < 46) last.label = ''
    ticks.push({ x: s.x0, label: clock(s.t0), gap: false })
    for (let t = Math.ceil((s.t0 + 1) / step) * step; t < s.t1; t += step) {
      const x = s.x0 + (t - s.t0) * pxPerMs
      if (x - ticks[ticks.length - 1]!.x >= 60) ticks.push({ x, label: clock(t), gap: false })
    }
  }
  return ticks
}

/** What a participant is called on its lane: a separate task by what it was asked (every one of them carries its
 *  connector's name as its label, which tells them apart not at all); a group member by its label; the main agent by
 *  its route. */
function laneName(p: Participant, first: CollabRun | undefined, group: CollabGroup | undefined): { label: string; sub: string } {
  const head = (first?.user_text_head ?? '').trim()
  if (p.role === 'separate' && head) return { label: head, sub: `${p.label} · separate task` }
  if (p.role === 'main') return { label: p.label, sub: 'the session\'s agent' }
  if (p.role === 'member') return { label: p.label, sub: [group?.template ?? group?.kind ?? 'group', p.alias].filter(Boolean).join(' · ') }
  return { label: p.label, sub: p.role }
}

/** Who dispatches in this session: the director when one is open, else the connector's client, else the person. */
function dispatcherName(graph: Pick<CollaborationGraph, 'actors' | 'runs'>): { label: string; sub: string } {
  const director = graph.actors.find((a) => a.kind === 'director')
  if (director && director.kind === 'director') return { label: director.label || director.model, sub: 'director · dispatches' }
  const client = graph.runs.map((r) => r.collab.origin?.client).find((c): c is string => !!c)
  return client ? { label: client, sub: 'connector · dispatches' } : { label: 'You', sub: 'dispatches' }
}

const running = (r: CollabRun): boolean => !!r.live || r.status === 'running' || r.status === 'queued'

/** `expanded`: the settled row open, its agents on lanes of their own again; `keep`: runs whose lanes never fold (a
 *  watch each set still waits). */
export function layoutRelations(graph: Pick<CollaborationGraph, 'actors' | 'participants' | 'runs' | 'edges' | 'groups'> & { nodes?: CollabNode[] }, opts: { width: number; now: number; clock: (t: number) => string; expanded?: boolean; keep?: ReadonlySet<string> }): RelationsLayout {
  const end = (r: CollabRun): number => (r.finished_at ? ms(r.finished_at) : running(r) ? opts.now : ms(r.created_at))
  const runs = [...graph.runs].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const byParticipant = new Map<string, CollabRun[]>()
  const byHand: CollabRun[] = []
  for (const r of runs) {
    const pid = r.collab.participant_id
    if (!pid) { byHand.push(r); continue }
    const own = byParticipant.get(pid)
    if (own) own.push(r)
    else byParticipant.set(pid, [r])
  }
  const dispatched = new Set<string>()
  for (const r of runs) if (r.collab.origin && DIRECTING.has(r.collab.origin.actor)) dispatched.add(r.id)
  for (const e of graph.edges) if (e.kind === 'dispatched' && e.to.kind === 'run') dispatched.add(e.to.id)

  // lanes: the dispatcher's over everyone when it dispatched anything; the main agent; the rest by group, then by when
  // they first worked; what the person did by hand under them
  const lanes: Lane[] = []
  const y = (): number => AXIS_H + lanes.length * LANE_H
  if (dispatched.size) lanes.push({ id: 'dispatcher', kind: 'dispatcher', ...dispatcherName(graph), participant_id: null, role: null, group_id: null, y: y() })
  const groupOf = (p: Participant): string | null => p.group?.id ?? null
  const groups = new Map(graph.groups.map((g) => [g.id, g]))
  const first = (p: Participant): string => byParticipant.get(p.id)?.[0]?.created_at ?? '~'
  const planned = (graph.nodes ?? []).filter((n) => n.run_ids.length === 0 && n.participant_id && !['cancelled', 'skipped'].includes(n.status))
  const plannedFor = new Set(planned.map((n) => n.participant_id))
  const ordered = [...graph.participants].filter((p) => byParticipant.has(p.id) || plannedFor.has(p.id)).sort((a, b) =>
    (a.role === 'main' ? 0 : 1) - (b.role === 'main' ? 0 : 1) || (groupOf(a) ?? '~').localeCompare(groupOf(b) ?? '~') || first(a).localeCompare(first(b)))
  // a long board folds the agents that settled into one row where the first of them stood; one that runs, has a step
  // still to come or a watch still waiting, or ended less than SETTLED_MS ago keeps its lane
  const settled = (p: Participant): boolean => p.role !== 'main' && !plannedFor.has(p.id)
    && byParticipant.get(p.id)!.every((r) => !running(r) && !opts.keep?.has(r.id) && end(r) <= opts.now - SETTLED_MS)
  const laneCount = lanes.length + ordered.length + (byHand.length ? 1 : 0)
  const foldable = laneCount > FOLD_LANES_ABOVE ? ordered.filter((p) => byParticipant.has(p.id) && settled(p)) : []
  const fold = new Set(foldable.length >= 2 ? foldable.map((p) => p.id) : [])
  let settlesAt: number | null = null
  if (laneCount > FOLD_LANES_ABOVE) for (const p of ordered) {
    const own = byParticipant.get(p.id)
    if (!own || p.role === 'main' || plannedFor.has(p.id) || own.some((r) => running(r) || opts.keep?.has(r.id))) continue
    const at = own.reduce((t, r) => Math.max(t, end(r)), 0) + SETTLED_MS
    if (at > opts.now && (settlesAt === null || at < settlesAt)) settlesAt = at
  }
  for (const p of ordered) {
    if (fold.has(p.id)) {
      if (p === foldable[0]) lanes.push({ id: 'settled', kind: 'settled', label: `${fold.size} ended agents`, sub: opts.expanded ? 'shown below · fold them' : `ended over ${SETTLED_MS / 60_000}m ago · show them`, participant_id: null, role: null, group_id: null, y: y(), count: fold.size })
      if (!opts.expanded) continue
    }
    const { label, sub } = laneName(p, byParticipant.get(p.id)?.[0], groups.get(groupOf(p) ?? ''))
    lanes.push({ id: p.id, kind: 'participant', label, sub, participant_id: p.id, role: p.role, group_id: groupOf(p), y: y() })
  }
  if (byHand.length) lanes.push({ id: 'hand', kind: 'hand', label: 'By hand', sub: `${byHand.length} action${byHand.length === 1 ? '' : 's'}: checkpoints, commands`, participant_id: null, role: null, group_id: null, y: y() })

  const scale = timeScale(runs.map((r) => [ms(r.created_at), end(r)]), opts.width)
  const laneOf = new Map(lanes.map((l) => [l.id, l]))
  const settledLane = opts.expanded ? undefined : laneOf.get('settled')
  // a step that went on in further runs (a watch's report, words sent to it, a run again): its second run "a1·2"
  const seen = new Map<string, number>()
  const tagOf = (r: CollabRun): string | null => {
    if (!r.interaction_node) return null
    const key = `${r.interaction_id ?? r.relay_id ?? ''}/${r.interaction_node}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    return n === 1 ? r.interaction_node : `${r.interaction_node}·${n}`
  }
  // every run has a place: its bar, or — folded — its stretch on the settled row
  const bars: Bar[] = []
  const placed = new Map<string, Pick<Bar, 'lane' | 'x0' | 'x1' | 'y'>>()
  for (const r of runs) {
    const tag = tagOf(r)
    const lane = settledLane && fold.has(r.collab.participant_id!) ? settledLane : laneOf.get(r.collab.participant_id ?? 'hand') ?? laneOf.get('hand')!
    const x0 = scale.x(ms(r.created_at))
    const at = { lane: lane.id, x0, x1: Math.max(x0 + (lane.kind === 'hand' ? 2 : 5), scale.x(end(r))), y: lane.y + (LANE_H - BAR_H) / 2 }
    placed.set(r.id, at)
    if (lane !== settledLane) bars.push({ run: r, ...at, tag })
  }
  const spans: Span[] = []
  if (settledLane) {
    const folded = [...placed.values()].filter((p) => p.lane === 'settled').sort((a, b) => a.x0 - b.x0)
    for (const f of folded) {
      const last = spans[spans.length - 1]
      if (last && f.x0 <= last.x1 + 2) last.x1 = Math.max(last.x1, f.x1)
      else spans.push({ x0: f.x0, x1: f.x1, y: f.y })
    }
  }
  const mid = (b: { y: number }): number => b.y + BAR_H / 2

  const links: Link[] = []
  const dispatcher = laneOf.get('dispatcher')
  if (dispatcher) for (const id of dispatched) {
    const b = placed.get(id)
    // the settled row says who worked, not who sent each of them
    if (b && b.lane !== 'settled') links.push({ id: `d-${id}`, kind: 'dispatched', from: { x: b.x0, y: dispatcher.y + LANE_H / 2 }, to: { x: b.x0, y: b.y }, run_from: null, run_to: id, lane_from: dispatcher.id, lane_to: b.lane, chars: null })
  }
  for (const e of graph.edges as CollabEdge[]) {
    if (e.from.kind !== 'run' || e.to.kind !== 'run') continue
    if (e.kind !== 'received' && e.kind !== 'cited' && e.kind !== 'after' && e.kind !== 'continues') continue
    const a = placed.get(e.from.id), b = placed.get(e.to.id)
    if (!a || !b) continue
    // a conversation going on in its own lane is the lane itself: drawn only when it changes lanes; what passed
    // between two settled agents stays folded with them
    if (a.lane === b.lane && (e.kind === 'continues' || a.lane === 'settled')) continue
    const meta = (e as { meta?: Record<string, unknown> }).meta ?? {}
    links.push({ id: e.id, kind: e.kind, from: { x: a.x1, y: mid(a) }, to: { x: b.x0, y: mid(b) }, run_from: e.from.id, run_to: e.to.id, lane_from: a.lane, lane_to: b.lane, chars: typeof meta.handed_chars === 'number' ? meta.handed_chars : null })
  }

  // the steps still to come: after everything that ran, one column per wave
  let end0 = PAD_X
  if (placed.size) { end0 = -Infinity; for (const p of placed.values()) end0 = Math.max(end0, p.x1 + 10) }
  const firstWave = planned.reduce((w, n) => Math.min(w, n.wave), Infinity)
  const ghosts: Ghost[] = planned.flatMap((n) => {
    const lane = laneOf.get(n.participant_id!)
    if (!lane) return []
    const x0 = end0 + (n.wave - firstWave) * (GHOST_W + 8)
    return [{ id: n.id, lane: lane.id, x0, x1: x0 + GHOST_W, y: lane.y + (LANE_H - BAR_H) / 2, tag: n.node_id }]
  })
  const right = ghosts.reduce((w, g) => Math.max(w, g.x1 + PAD_X), scale.width)
  const nowX = runs.some(running) ? scale.x(opts.now) : null
  return { lanes, bars, ghosts, spans, settles_at: settlesAt, now_x: nowX, links, ticks: ticksOf(scale.segments, scale.pxPerMs, opts.clock), width: Math.max(right, opts.width), height: AXIS_H + lanes.length * LANE_H + 6, px_per_min: scale.pxPerMs * 60_000 }
}
