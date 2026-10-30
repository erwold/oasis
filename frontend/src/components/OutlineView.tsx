import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { BOT_HEX, botColor, buildTree, durationOf, inkOn, LIVE_STATUSES, parentOf, railsOf, rowWindow, selectionChain, stateClock, waitingLine, waitingTitle, waitsNames, type BotState, type Glyph, type OutlineNode, type RailEdge, type RailLine, type RunWaiting, type TreeRow } from '../state/outline'
import { BotImage, type BotStill } from './BotImage'
import { ChevronDownIcon, FolderOpenIcon, UserIcon } from './icons'

/** The Agent Teams outline as it is drawn (carried from oasis components/AgentOutline.tsx, see NOTICE), apart from
 *  where its rows come from: one row per piece of work — a run, a plan's node not started yet, the director's plan, the
 *  decision that is the person's — indented under whoever scheduled it, the folder on top, like Blender's outliner.
 *  Its name is the order's label or the person's first line; its right side says what it is doing: the row's short
 *  id, its duration and the glyph its record measured; `running`; `waits B, C` while it waits; `sleeping` for a
 *  director whose plan runs; `after A` / `needs you` for the decision. A hairline runs from each parent's icon into its
 *  child's, in the child's colour (who scheduled whom); a dashed line at the right edge runs from a row to the row that
 *  waits for it (who waits for whom); the selected chain and the edges into and out of the selected row light up.
 *
 *  Pure: it reads no store and acts on nothing. The app's dock (AgentOutline.tsx) gives it the session's runs, its
 *  bots' live states, the selected row and what a click does; a share's page gives it the team its projection carries
 *  (src/share/team.ts), its rows' states from their status, and a click that only scrolls its own thread. Only the
 *  folds, the scroll and the clock are its own. */

/** One row as the outline draws it: what the tree reads (TreeRow — `parent_run_id` is the row it hangs under) and
 *  what the row shows. */
export interface OutlineItem extends TreeRow {
  depends_on: string[]
  kind: 'run' | 'ask' | 'plan' | 'decision'
  status: string
  bot: string | null
  name: string
  /** the model's name; null for a person's action or decision */
  model: string | null
  participant_index: number | null
  participant_name: string | null
  participant_alias: string | null
  /** how many runs the row folds (a run continued by follow-ups is one row) */
  runs: number
  created_at: string
  finished_at: string | null
  glyph: Glyph
  glyph_title: string
  /** the id the row is known by (its tooltip, its short form on the right); null: none to show */
  ref: string | null
  /** what holds the folder a queued row waits for; null: nothing named */
  lock: RunWaiting | null
}

const IND = 20
const ROW = 24

const GLYPH: Record<Exclude<Glyph, null>, ReactElement> = {
  done: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>,
  warn: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>,
  bad: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  err: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"><path d="M12 5v9M12 18v.5" /></svg>,
}
/** the decision's mark: a fork — the person's choice among the branches */
const FORK = <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v16M12 12l6-4M12 12l-6-4" /></svg>
/** a live row's dot (it breathes, by CSS, only while the row's state says its run works) */
const RING = <span className="ol-ring" aria-hidden />

/** the rows drawn beyond the outline's view on each side (a list shorter than the view and twice this draws whole) */
const OVERSCAN = 30
const NO_ENTRIES: never[] = []

const colorOf = (row: OutlineItem | undefined): string => (row?.kind === 'decision' ? 'var(--accent)' : botColor(row?.bot ?? null))

/** What the row's right side says, by its kind and state. */
function RightText({ row, names, now, hidden }: { row: OutlineItem; names: string[]; now: number; hidden: number }) {
  const glyph = row.glyph
  const bold = names.map((n, i) => <Fragment key={i}>{i > 0 && ', '}<b>{n}</b></Fragment>)
  const count = hidden > 0 ? <span className="ol-cnt">+{hidden}</span> : null
  if (row.kind !== 'run' && row.status === 'cancelled') return <><span className="ol-deps" data-testid={`stopped-${row.id}`}>stopped</span>{count}</>
  if (row.kind === 'decision') {
    if (row.status === 'queued') return <><span className="ol-deps" data-testid={`after-${row.id}`}>after {bold}</span>{count}</>
    if (row.status === 'waiting') return <><span className="ol-pill need" data-testid={`needs-you-${row.id}`}>needs you</span>{count}</>
    return <>{glyph && <span className={`ol-st ${glyph}`} title={row.glyph_title}>{GLYPH[glyph]}</span>}{count}</>
  }
  if (row.kind === 'plan' && row.status === 'running') return <><span className="ol-pill run">{RING}planning</span>{count}</>
  if (row.kind === 'plan' && row.status === 'waiting') return <><span className="ol-pill wait" data-testid={`sleeping-${row.id}`}>sleeping</span>{count}</>
  if (row.status === 'running') return <><span>{durationOf(row, now)}</span><span className="ol-pill run">{RING}running</span>{count}</>
  if (row.status === 'queued' && names.length) return <><span className="ol-deps" data-testid={`waits-${row.id}`}>waits {bold}</span>{count}</>
  // queued behind what holds its folder (when the row names it): named, never shown as running
  const lock = row.status === 'queued' ? row.lock : null
  if (lock) return <><span className="ol-deps" data-testid={`waits-lock-${row.id}`} title={waitingTitle(lock)}>{waitingLine(lock)}</span>{count}</>
  return (
    <>
      {row.ref && <span>{row.ref.slice(4, 10)}</span>}
      <span>{durationOf(row, now)}</span>
      {glyph && <span className={`ol-st ${glyph}`} data-testid={`glyph-${row.id}`} title={row.glyph_title}>{GLYPH[glyph]}</span>}
      {count}
    </>
  )
}

/** A row's bot state: a hook the outline calls once per drawn row — the SAME function for the life of the outline. */
export type UseRowState = (row: OutlineItem) => BotState

/** One row of the outline: drawn again when its own row, its place or its state changes — its bot's state read for
 *  its own row alone, its clock still once it can no longer change with the time (stateClock). */
const OutlineRow = memo(function OutlineRow({ row, depth, kids, isClosed, selected, dim, byId, clock, useRowState, onOpen, onToggle, botStill }: {
  row: OutlineItem; depth: number; kids: number; isClosed: boolean; selected: boolean; dim: boolean
  /** a share's still pictures (its rows' bots are those, never an animation): BotImage's `still` */
  botStill?: BotStill
  /** the rows by id, for a row that waits on others (their names); none for a row that waits on nothing */
  byId: Map<string, OutlineItem> | undefined; clock: number; useRowState: UseRowState; onOpen: (row: OutlineItem) => void; onToggle: (id: string) => void
}) {
  const state: BotState = useRowState(row)
  const bot = row.bot
  const names = byId ? waitsNames(row, byId) : NO_ENTRIES
  const who = row.model ?? (row.kind === 'decision' ? 'your decision' : 'a person')
  return (
    <div className={`ol-node${kids ? ' has' : ''}${isClosed ? ' closed' : ''}${selected ? ' sel' : ''}${dim ? ' dim' : ''}${row.glyph === 'err' ? ' fail' : ''}${row.status === 'queued' ? ' queued' : ''}${row.kind !== 'run' ? ` ${row.kind}` : ''}`}
         data-id={row.id} data-testid={`ol-${row.id}`} data-state={state} data-status={row.status} data-kind={row.kind} data-alias={row.participant_alias ?? undefined}
         style={{ ['--ind' as string]: `${6 + (depth + 1) * IND}px`, ['--c' as string]: colorOf(row), height: ROW }}
         title={`${row.participant_name ? `${row.participant_name} · ` : ''}${row.ref ? `${row.ref} · ` : ''}${who} · ${row.status}${row.status === 'running' ? ` · ${state}` : ''}${row.runs > 1 ? ` · ${row.runs} runs` : ''}${names.length ? ` · after ${names.join(', ')}` : ''}`}
         onClick={() => onOpen(row)}>
      <span />
      <span className="ol-lbl">
        <span className="ol-ico" data-state={state}>
          {bot ? <BotImage bot={bot} state={state} still={botStill} /> : row.kind === 'decision' ? FORK : <UserIcon size={12} />}
          {bot && row.participant_index !== null && <span className="ol-alias" data-testid={`alias-${row.id}`} title={`${row.participant_name ? `${row.participant_name} · ` : ''}place ${row.participant_index + 1} in its group`} style={{ ['--c' as string]: botColor(bot), ['--ink-on-c' as string]: inkOn(BOT_HEX[bot] ?? '#888888') }}>{row.participant_index + 1}</span>}
        </span>
        <span className="ol-caret" onClick={(e) => { e.stopPropagation(); onToggle(row.id) }}>
          <ChevronDownIcon size={10} />
        </span>
        <span className="ol-nm">{row.name}</span>
      </span>
      <span className="ol-right">
        <RightText row={row} names={names} now={clock} hidden={kids > 0 && isClosed ? kids : 0} />
      </span>
    </div>
  )
})

/** The outline: the folder (`title`) and the rows under it. A memo: it draws for what it shows alone. */
export const OutlineView = memo(function OutlineView({ title, rows, selected, onOpen, useRowState, botStill }: {
  title: string
  rows: readonly OutlineItem[]
  /** the row lit with its chain (ancestors, subtree, what it waits for and what waits for it) */
  selected: string | null
  onOpen: (row: OutlineItem) => void
  useRowState: UseRowState
  /** a share's page: every bot drawn from the stills it carries (the app's outline leaves it out: its bots play) */
  botStill?: BotStill
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())
  const treeRef = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<RailLine[]>([])
  const [edges, setEdges] = useState<RailEdge[]>([])
  // the tree's width: the dependency lanes stand at its right edge, wherever the dock is resized to
  const [width, setWidth] = useState(0)
  // the rows drawn: those in the tree's view and a margin around them (every row is ROW tall)
  const [win, setWin] = useState({ start: 0, end: OVERSCAN * 2 })
  const toggle = useCallback((id: string) => setClosed((s) => { const t = new Set(s); if (t.has(id)) t.delete(id); else t.add(id); return t }), [])
  // the clock behind the transient states (done / blocked play for a moment, then the icon settles)
  const transient = rows.some((r) => LIVE_STATUSES.has(r.status) || (r.finished_at && now - Date.parse(r.finished_at) < 45_000))
  useEffect(() => {
    if (!transient) return
    // a hidden page draws nothing on the clock; back in view, at once
    const tick = () => { if (!document.hidden) setNow(Date.now()) }
    const timer = window.setInterval(tick, 1000)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [transient])
  const roots = useMemo(() => buildTree(rows), [rows])
  const visible = useMemo(() => {
    const out: OutlineNode<OutlineItem>[] = []
    const walk = (n: OutlineNode<OutlineItem>) => { out.push(n); if (!closed.has(n.row.id)) n.children.forEach(walk) }
    roots.forEach(walk)
    return out
  }, [roots, closed])
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  // which rows are in view: read on a scroll (once a frame), a resize, and a list grown or shrunk
  const count = visible.length
  const measure = useCallback(() => {
    const el = treeRef.current
    if (!el) return
    const next = rowWindow(el.scrollTop - ROW, el.clientHeight, count, ROW, OVERSCAN)
    setWin((w) => (w.start === next.start && w.end === next.end ? w : next))
  }, [count])
  useLayoutEffect(measure, [measure])
  useEffect(() => {
    const el = treeRef.current
    if (!el) return
    let frame: number | null = null
    const onScroll = () => { if (frame === null) frame = requestAnimationFrame(() => { frame = null; measure() }) }
    const observer = new ResizeObserver(() => { setWidth(el.clientWidth); measure() })
    observer.observe(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { observer.disconnect(); el.removeEventListener('scroll', onScroll); if (frame !== null) cancelAnimationFrame(frame) }
  }, [measure])
  const start = Math.min(win.start, count), end = Math.min(win.end, count)
  // the lit rows: the selected one, its ancestors, its subtree, and what it waits for or what waits for it
  const chain = useMemo(() => selectionChain(rows, selected), [rows, selected])
  // the spawn lines light along the selected chain only (ancestors and the subtree), never along a dependency
  const spawnLit = useMemo(() => {
    const lit = new Set<string>()
    if (!selected) return lit
    let cur = byId.get(selected)
    while (cur) { lit.add(cur.id); const up = parentOf(cur); cur = up ? byId.get(up) : undefined }
    const under = (id: string) => { let c = byId.get(id); while (c) { if (c.id === selected) return true; const up = parentOf(c); c = up ? byId.get(up) : undefined } return false }
    for (const r of rows) if (under(r.id)) lit.add(r.id)
    return lit
  }, [byId, rows, selected])
  // the hairline rail: an elbow from each parent's icon down and into its child's icon; the dependency lanes at
  // the right edge, one per edge the waiting row has (drawn after layout). The folder's icon and the first drawn
  // row's are measured; every other row stands a whole number of rows and indents from it (railsOf)
  useLayoutEffect(() => {
    const el = treeRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const centre = (ico: Element | null | undefined) => {
      if (!ico) return null
      const b = ico.getBoundingClientRect()
      return { x: b.left - box.left + b.width / 2 + el.scrollLeft, y: b.top - box.top + b.height / 2 + el.scrollTop }
    }
    const first = visible[start]
    const at = first ? centre(el.querySelector(`.ol-node[data-id="${CSS.escape(first.row.id)}"] .ol-ico`)) : null
    const folder = centre(el.querySelector('.ol-node.folder .ol-ico'))
    const { lines: nextLines, edges: nextEdges } = railsOf({
      visible, roots, closed, folder, ref: first && at ? { index: start, depth: first.depth, at } : null,
      ind: IND, rowH: ROW, right: el.clientWidth, top: start * ROW, bottom: (end + 1) * ROW,
      spawnLit, selected, colorOf: (id) => colorOf(byId.get(id)),
    })
    setLines(nextLines)
    setEdges(nextEdges)
  }, [visible, closed, selected, spawnLit, roots, byId, width, start, end])

  return (
    <div className="agent-outline embedded" data-testid="outline">
      <div className="ol-tree" ref={treeRef}>
        <svg className={`ol-rail${selected ? ' has-sel' : ''}`} aria-hidden="true">
          <defs>
            <marker id="ol-arr" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L6 3L0 6z" fill="context-stroke" /></marker>
          </defs>
          <g data-testid="ol-deps">
            {edges.map((e) => (
              <g key={e.key}>
                <circle className={`ol-dep-dot${e.lit ? ' lit' : ''}`} cx={e.x} cy={e.y1} r={1.6} fill={e.color} fillOpacity={e.lit ? 1 : 0.7} />
                <path className={`ol-dep${e.lit ? ' lit' : ''}`} d={`M${e.x} ${e.y1} L${e.x} ${e.y2}`} stroke={e.color} strokeOpacity={e.lit ? 0.95 : 0.6} markerEnd="url(#ol-arr)" />
                {e.lit && <path className="ol-flow" d={`M${e.x} ${e.y1} L${e.x} ${e.y2}`} stroke={e.color} strokeWidth={2.2} strokeDasharray="18 38" style={{ ['--len' as string]: `${e.y2 - e.y1}` }} />}
              </g>
            ))}
          </g>
          {lines.map((l) => (
            <g key={l.key}>
              <path className={`ol-base${l.lit ? ' lit' : ''}${selected ? ' has-sel' : ''}`} d={l.d} stroke={l.color} strokeOpacity={l.lit ? 0.95 : 0.55} />
              {l.lit && <path className="ol-flow" d={l.d} stroke={l.color} strokeWidth={2.2} strokeDasharray="18 38" style={{ ['--len' as string]: `${l.len}` }} />}
            </g>
          ))}
        </svg>
        <div className="ol-node folder" data-id="__session" style={{ ['--ind' as string]: '6px' }} title={title}>
          <span />
          <span className="ol-lbl"><span className="ol-ico"><FolderOpenIcon size={12} /></span><span className="ol-nm">{title}</span></span>
          <span className="ol-right"><span className="ol-cnt">{roots.length}</span></span>
        </div>
        {start > 0 && <div className="ol-gap" style={{ height: start * ROW }} aria-hidden="true" />}
        {visible.slice(start, end).map((n) => {
          const row = n.row
          return (
            <OutlineRow key={row.id} row={row} depth={n.depth} kids={n.children.length} isClosed={closed.has(row.id)} selected={selected === row.id}
                        dim={!!selected && !chain.has(row.id)} byId={row.depends_on.length ? byId : undefined} clock={stateClock(row, now)}
                        useRowState={useRowState} onOpen={onOpen} onToggle={toggle} botStill={botStill} />
          )
        })}
        {end < count && <div className="ol-gap" style={{ height: (count - end) * ROW }} aria-hidden="true" />}
      </div>
    </div>
  )
})
