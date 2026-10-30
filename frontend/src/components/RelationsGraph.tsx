import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { CollaborationGraph } from '@oasis-code/contract'
import { AXIS_H, BAR_H, LANE_H, layoutRelations, tickClearsNow, watchMarks, type Bar, type Lane, type Link, type LinkKind } from '../state/relationsGraph'
import { hoverChannel, indexLayout, laneRange, passingLine, sameRange, viewOf, VIRTUAL_ABOVE, type HoverChannel, type LaneRange } from '../state/relationsViewport'
import { useStore } from '../state/store'
import { waitingWatches, watchLabel } from '../state/watches'
import { botColor, CHATGPT_BOT, DIRECTOR_BOT } from '../state/outline'
import { BotImage, useDirectorPresence, useRunPresence } from './BotImage'
import type { Lineage } from '../state/lineage'
import { botsOfRuns } from './useCollab'
import { frontRun, useDesk } from '../state/desk'
import { cardStateWord, frontLaneOf, liveTickMs, stateWord } from './AgentPresentation'
import { LiveHead } from './AgentPresentationView'

const LINK_WORDS: Record<LinkKind, { name: string; title: string }> = {
  received: { name: 'handed over', title: 'The earlier run\'s answer was put into the later run\'s message' },
  cited: { name: 'cited', title: 'Referred to only: its content was not handed over' },
  dispatched: { name: 'dispatched', title: 'Started by the director (or the connector\'s client)' },
  after: { name: 'ran after', title: 'Scheduling only: waited for it, was handed nothing' },
  continues: { name: 'continues', title: 'The same conversation on another lane' },
}
// what was handed, cited or dispatched; the many "ran after" and "continues" lines say what the lanes already show
const SHOWN: ReadonlySet<LinkKind> = new Set(['received', 'cited', 'dispatched'])
const shown = (l: Link): boolean => SHOWN.has(l.kind)
const GUTTER = 168
// a narrow dock gives the timeline the room: the lanes keep their pictures, their names go to the tooltip
const GUTTER_COMPACT = 34
const COMPACT_BELOW = 560
// what a long board draws before it has measured where the thread's scroll stands
const FIRST_VIEW_H = 720

const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const duration = (a: string, b: string | null): string => {
  const m = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
const path = (a: { x: number; y: number }, b: { x: number; y: number }): string => {
  const dx = Math.max(18, Math.abs(b.x - a.x) / 2)
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`
}
const linkPath = (l: Link): string => (l.kind === 'dispatched' ? `M${l.from.x},${l.from.y} L${l.to.x},${l.to.y - 1}` : path(l.from, l.to))

/** The nearest ancestor that scrolls vertically (the thread), or null: the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY)) return p
  return null
}

/** The lanes a long board keeps in the DOM: the ones its scroll container shows and OVERSCAN around them, measured
 *  again as that container scrolls or changes size; a new range only when the lanes shown change. */
function useLaneRange(anchor: RefObject<SVGSVGElement | null>, laneCount: number): LaneRange {
  const virtual = laneCount > VIRTUAL_ABOVE
  const [range, setRange] = useState(() => laneRange(laneCount, 0, FIRST_VIEW_H))
  useLayoutEffect(() => {
    const el = anchor.current
    if (!virtual || !el) return
    const scroller = scrollParent(el as unknown as HTMLElement)
    const measure = () => {
      const port = scroller ? scroller.getBoundingClientRect() : { top: 0, height: window.innerHeight }
      const next = laneRange(laneCount, port.top - el.getBoundingClientRect().top, port.height)
      setRange((prev) => (sameRange(prev, next) ? prev : next))
    }
    measure()
    const target: HTMLElement | Window = scroller ?? window
    target.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    const observer = new ResizeObserver(measure)
    if (scroller) observer.observe(scroller)
    observer.observe(el)
    return () => {
      target.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [anchor, laneCount, virtual])
  if (!virtual) return { first: 0, last: laneCount - 1 }
  const last = Math.min(range.last, laneCount - 1)
  return { first: Math.min(range.first, last), last }
}

/** The relations as a timeline: who worked when, who dispatched whom, whose answer went into whose message. A bar is
 *  a run (click: its card, at that run); an arrow, a relation (its kinds switch on and off in the legend). */
/** `laneState`: an agent's lane by its participant id → where its latest run stands, said beside its name (a click
 *  on the name opens that run's card). */
export function RelationsGraph({ graph, agents, onOpen, testId = 'relations-graph', laneState }: { graph: CollaborationGraph; agents: Lineage[]; onOpen: (runId: string) => void; testId?: string; laneState?: Map<string, { status: string; run_id: string }> }) {
  const box = useRef<HTMLDivElement>(null)
  const outer = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(480)
  const [compact, setCompact] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [hover] = useState(hoverChannel)
  // the time the board is laid out by: taken again with every new graph, every 15 s while a run works, and when the
  // next agent of a long board settles (its lane folds then, though nothing runs and no new graph comes)
  const [clockAt, setClockAt] = useState(() => ({ graph, now: Date.now() }))
  if (clockAt.graph !== graph) setClockAt({ graph, now: Date.now() })
  const now = clockAt.now
  const tick = () => setClockAt((c) => ({ graph: c.graph, now: Date.now() }))
  const live = graph.runs.some((r) => r.live)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setWidth(Math.max(160, el.clientWidth))
      setCompact((outer.current?.clientWidth ?? COMPACT_BELOW) < COMPACT_BELOW)
    })
    observer.observe(el)
    if (outer.current) observer.observe(outer.current)
    return () => observer.disconnect()
  }, [])
  const session = useStore((s) => s.session)
  const watches = useMemo(() => waitingWatches(session), [session])
  // an agent with a watch still waiting keeps its lane
  const keep = useMemo(() => new Set(watches.map((w) => w.run_id)), [watches])
  const layout = useMemo(() => layoutRelations(graph, { width, now, clock, expanded, keep }), [graph, width, now, expanded, keep])
  // a live run's bar grows while it works: laid out again as soon as it has grown a pixel at the board's scale (once a
  // second at most, every 15 s at least), never while the page is hidden — back in view, at once
  const every = live ? liveTickMs(layout.px_per_min) : 0
  useEffect(() => {
    if (!every) return
    const step = () => { if (!document.hidden) tick() }
    const t = setInterval(step, every)
    document.addEventListener('visibilitychange', step)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', step) }
  }, [every])
  // the agent whose card is at the front: its lane stands out, the others step back
  const front = useDesk((s) => frontRun(s.windows))
  const frontLane = useMemo(() => {
    const agent = front ? agents.find((a) => a.id === front) : undefined
    return frontLaneOf(layout.bars, new Set(agent ? agent.lineage.map((r) => r.id) : front ? [front] : []))
  }, [front, agents, layout.bars])
  const marks = useMemo(() => watchMarks(layout.bars, watches.map((w) => ({ run_id: w.run_id, label: watchLabel(w, now) }))), [layout.bars, watches, now])
  const index = useMemo(() => indexLayout(layout, shown), [layout])
  const range = useLaneRange(svg, layout.lanes.length)
  const view = useMemo(() => viewOf(index, marks, range), [index, marks, range])
  useEffect(() => {
    if (layout.settles_at === null) return
    const t = setTimeout(tick, Math.max(0, layout.settles_at - Date.now()) + 1_000)
    return () => clearTimeout(t)
  }, [layout.settles_at])
  const passing = passingLine(view.passing)
  const colorOfLane = useMemo(() => {
    const botOfRun = botsOfRuns(agents)
    const participant = new Map(graph.participants.map((p) => [p.id, p]))
    const dispatcherBot = graph.actors.some((a) => a.kind === 'director') ? DIRECTOR_BOT : graph.runs.some((r) => r.collab.origin?.client === 'ChatGPT') ? CHATGPT_BOT : null
    const botOf = (lane: Lane): string | null => {
      if (lane.kind === 'dispatcher') return dispatcherBot
      if (lane.kind !== 'participant') return null
      const latest = participant.get(lane.participant_id!)?.latest_run_id
      return latest ? botOfRun.get(latest) ?? null : null
    }
    // the run a lane's bot plays: its participant's current run (the dispatcher's is the director's own state)
    const runOf = (lane: Lane): string | null => (lane.kind === 'participant' ? participant.get(lane.participant_id!)?.latest_run_id ?? null : null)
    return new Map(layout.lanes.map((l) => [l.id, { bot: botOf(l), run: runOf(l), color: l.kind === 'participant' ? botColor(botOf(l)) : 'var(--line-strong)' }]))
  }, [agents, graph, layout.lanes])
  const barOf = useMemo(() => new Map(layout.bars.map((b) => [b.run.id, b])), [layout.bars])
  const laneOf = useMemo(() => new Map(layout.lanes.map((l) => [l.id, l])), [layout.lanes])
  const toggle = () => setExpanded((e) => !e)
  if (!layout.bars.length && !layout.ghosts.length && !layout.spans.length) return <p className="dim small" data-testid="relations-graph-empty">Nothing has run in this session yet.</p>
  const linkColor = (l: Link): string => colorOfLane.get(l.lane_from)?.color ?? 'var(--ink-3)'
  // an arrow with an end on a lane not drawn says where it goes
  const mounted = new Set(view.lanes.map((l) => l.id))
  const offEnd = (l: Link): string => {
    const far = !mounted.has(l.lane_from) ? l.lane_from : !mounted.has(l.lane_to) ? l.lane_to : null
    return far === null ? '' : ` · ${far === l.lane_from ? 'from' : 'to'} ${laneOf.get(far)?.label ?? far}, off screen`
  }
  return (
    <div className={`rg${compact ? ' compact' : ''}${frontLane ? ' has-front' : ''}`} ref={outer} data-testid={testId} data-lanes={layout.lanes.length} data-mounted={view.lanes.length}>
      {/* what passes the lanes on screen with no end on them, counted, not drawn: in sight while the board is, at its
          right, over the timeline — it takes no room of its own (the board does not move as it comes and goes) and
          covers no lane's name, nor takes the pointer */}
      {layout.lanes.length > VIRTUAL_ABOVE && <div className="rg-offscreen-anchor">{passing && <div className="rg-offscreen dim small" data-testid="rg-offscreen">{passing}</div>}</div>}
      <div className="rg-body">
        <div className="rg-gutter" style={{ width: compact ? GUTTER_COMPACT : GUTTER, paddingTop: view.lanes[0]?.y ?? AXIS_H }}>
          {view.lanes.map((lane) => {
            if (lane.kind === 'settled') return (
              <div key={lane.id} className="rg-lane-name is-settled opens" style={{ height: LANE_H }} title={`${lane.label}\n${lane.sub}`} data-testid="rg-lane-settled" data-expanded={expanded ? 'true' : 'false'} onClick={toggle}>
                <span className="rg-dot" />
                <span className="rg-lane-text"><span className="rg-lane-label">{lane.label}</span><span className="rg-lane-sub">{lane.sub}</span></span>
              </div>
            )
            const bot = colorOfLane.get(lane.id)?.bot ?? null
            const state = lane.participant_id ? laneState?.get(lane.participant_id) : undefined
            const word = state ? stateWord(state.status) : null
            const lead = state ? <LaneWord runId={state.run_id} status={state.status} /> : null
            return (
              <div key={lane.id} className={`rg-lane-name is-${lane.kind}${state ? ' opens' : ''}${lane.id === frontLane ? ' is-front' : ''}`} style={{ height: LANE_H, ['--c' as string]: colorOfLane.get(lane.id)?.color }} title={`${lane.label}\n${lane.sub}${word ? ` · ${word} — open its card` : ''}`}
                   data-testid={`rg-lane-${lane.id}`} data-state={state?.status} data-latest-run={state?.run_id} onClick={state ? () => onOpen(state.run_id) : undefined}>
                {bot ? <LaneBot bot={bot} runId={state?.run_id ?? colorOfLane.get(lane.id)?.run ?? null} dispatcher={lane.kind === 'dispatcher'} /> : <span className="rg-dot" />}
                {state && <i className={`rg-lane-dot is-${state.status}`} />}
                <span className="rg-lane-text"><span className="rg-lane-label">{lane.label}</span><span className="rg-lane-sub">{lead && <>{lead} · </>}{lane.sub}</span></span>
              </div>
            )
          })}
        </div>
        <div className="rg-scroll" ref={box}>
          {/* the run under the pointer is found here, once, and told to the tooltip and the lit arrows alone */}
          <svg ref={svg} width={layout.width} height={layout.height} className="rg-svg" onMouseLeave={() => hover.set(null, 0)}
               onMouseMove={(e) => hover.set((e.target as Element).closest('[data-run]')?.getAttribute('data-run') ?? null, e.nativeEvent.offsetX)}>
            <defs>
              <marker id="rg-arr" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L6 3L0 6z" fill="context-stroke" /></marker>
            </defs>
            {view.lanes.map((lane) => <rect key={lane.id} x={0} y={lane.y} width={layout.width} height={LANE_H} className={`${((lane.y - AXIS_H) / LANE_H) % 2 ? 'rg-row odd' : 'rg-row'}${lane.id === frontLane ? ' is-front' : ''}`} />)}
            {layout.ticks.map((t, i) => (
              <g key={i} className={t.gap ? 'rg-tick gap' : 'rg-tick'}>
                {!t.gap && <line x1={t.x} x2={t.x} y1={14} y2={layout.height} />}
                {t.gap
                  // a break's ⋯ is its mark (a break has no line): it stays; its minutes go while "now" stands on them
                  ? <text x={t.x} y={11} textAnchor="middle">{`⋯${t.label && tickClearsNow(t, layout.now_x) ? ` ${t.label}` : ''}`}</text>
                  : tickClearsNow(t, layout.now_x) && <text x={t.x + 3} y={11} textAnchor="start">{t.label}</text>}
              </g>
            ))}
            {view.lanes.some((l) => l.kind === 'settled') && layout.spans.length > 0 && (
              <g className="rg-settled" data-testid="rg-settled" onClick={toggle}>
                {layout.spans.map((s, i) => <rect key={i} x={s.x0} y={s.y + 3} width={s.x1 - s.x0} height={BAR_H - 6} rx={2} />)}
                <title>{`${laneOf.get('settled')?.label ?? ''}: when they worked — click to show them`}</title>
              </g>
            )}
            {view.bars.map((b) => {
              const lane = laneOf.get(b.lane)!
              const w = b.x1 - b.x0
              const hand = lane.kind === 'hand'
              // a run at work: its end is now, a ring on it; one that failed or was stopped: a mark at its end
              const running = !hand && (!!b.run.live || b.run.status === 'running')
              return (
                <g key={b.run.id} className={`rg-bar is-${b.run.status}${b.run.live ? ' live' : ''}${hand ? ' hand' : ''}${lane.id === frontLane ? ' is-front' : ''}`} data-testid={`rg-bar-${b.run.id}`} data-run={b.run.id} onClick={() => onOpen(b.run.id)}>
                  <rect x={b.x0} y={hand ? b.y + 4 : b.y + 2} width={w} height={hand ? BAR_H - 8 : BAR_H - 4} rx={hand ? 1 : 2} style={{ ['--c' as string]: colorOfLane.get(b.lane)!.color }} />
                  {!hand && (b.run.status === 'error' || b.run.status === 'cancelled') && !b.run.live && <rect className="rg-cap" x={b.x1 - 2.5} y={b.y} width={2.5} height={BAR_H} rx={1} />}
                  {b.tag && w > b.tag.length * 6 + 8 && <text x={b.x0 + 4} y={b.y + BAR_H - 4.5}>{b.tag}</text>}
                  {running && <LiveHead runId={b.run.id} x={b.x1} y={b.y + BAR_H / 2} />}
                </g>
              )
            })}
            {view.marks.map((m) => (
              <g key={m.lane} className="rg-watch" data-testid={`rg-watch-${m.lane}`} transform={`translate(${m.x + 4},${m.y})`}>
                <circle cx={BAR_H / 2} cy={BAR_H / 2} r={BAR_H / 2 - 2} />
                <path d={`M${BAR_H / 2},${BAR_H / 2 - 3.5} V${BAR_H / 2} H${BAR_H / 2 + 3}`} />
                <title>{`waits on: ${m.labels.join('; ')}`}</title>
              </g>
            ))}
            {layout.now_x !== null && (
              <g className="rg-now" data-testid="rg-now">
                <line x1={layout.now_x} x2={layout.now_x} y1={14} y2={layout.height} />
                <text x={layout.now_x} y={11} textAnchor="middle">now</text>
              </g>
            )}
            {view.ghosts.map((g) => (
              <g key={g.id} className="rg-ghost" data-testid={`rg-ghost-${g.tag}`}>
                <rect x={g.x0} y={g.y} width={g.x1 - g.x0} height={BAR_H} rx={4} />
                <text x={g.x0 + 5} y={g.y + BAR_H - 4}>{g.tag}</text>
                <title>{`step ${g.tag}: not started`}</title>
              </g>
            ))}
            {/* drawn as the Agent Teams outline draws its lines: hairlines in the colour of the run they come from, a
                small head; the lines of the run under the pointer lit and flowing over them (RelationsLit), the rest faded */}
            {view.links.map((l) => (
              <path key={l.id} d={linkPath(l)} className={`rg-link is-${l.kind}`} style={{ stroke: linkColor(l) }} markerEnd="url(#rg-arr)">
                <title>{`${LINK_WORDS[l.kind].name}${l.chars !== null ? ` · ${l.chars.toLocaleString()} characters` : ''}${offEnd(l)}`}</title>
              </path>
            ))}
            <RelationsLit hover={hover} linksOf={index.linksOfRun} color={linkColor} />
          </svg>
          <RelationsTip hover={hover} barOf={barOf} laneOf={laneOf} width={layout.width} height={layout.height} />
        </div>
      </div>
    </div>
  )
}

/** The arrows of the run under the pointer, lit and flowing: the only part of the board that draws again as the
 *  pointer goes from bar to bar. */
function RelationsLit({ hover, linksOf, color }: { hover: HoverChannel; linksOf: Map<string, Link[]>; color: (l: Link) => string }) {
  const run = useSyncExternalStore(hover.subscribe, hover.run, hover.run)
  if (run === null) return null
  return (
    <g className="rg-lit" data-testid="rg-lit" data-lit-run={run}>
      {(linksOf.get(run) ?? []).map((l) => {
        const d = linkPath(l)
        return (
          <g key={l.id}>
            <path data-lit="true" d={d} className={`rg-link is-${l.kind}`} style={{ stroke: color(l) }} markerEnd="url(#rg-arr)" />
            {l.kind !== 'dispatched' && <path className="ol-flow" d={d} stroke={color(l)} strokeWidth={2.2} strokeDasharray="18 38" />}
          </g>
        )
      })}
    </g>
  )
}

/** The hovered run's tooltip: drawn when the run under the pointer changes, moved by hand while the pointer moves. */
function RelationsTip({ hover, barOf, laneOf, width, height }: { hover: HoverChannel; barOf: Map<string, Bar>; laneOf: Map<string, Lane>; width: number; height: number }) {
  const run = useSyncExternalStore(hover.subscribe, hover.run, hover.run)
  const tip = useRef<HTMLDivElement>(null)
  const left = (x: number): number => Math.min(x + 12, width - 260)
  useEffect(() => hover.onMove((x) => { if (tip.current) tip.current.style.left = `${left(x)}px` }))
  const bar = run === null ? undefined : barOf.get(run)
  if (!bar) return null
  const above = bar.y > height / 2
  return (
    <div ref={tip} className={`rg-tip${above ? ' above' : ''}`} data-testid="rg-tip"
         style={above ? { left: left(hover.x()), bottom: height - bar.y + 6 } : { left: left(hover.x()), top: bar.y + BAR_H + 6 }}>
      <div className="rg-tip-head">{laneOf.get(bar.lane)?.label}{bar.tag ? ` · ${bar.tag}` : ''}</div>
      <div className="dim">{bar.run.status} · {clock(Date.parse(bar.run.created_at))} · {duration(bar.run.created_at, bar.run.finished_at)}{bar.run.model ? ` · ${bar.run.model}` : ''}</div>
      {bar.run.user_text_head && !/^App note\b/.test(bar.run.user_text_head) && <div className="rg-tip-text">{bar.run.user_text_head}</div>}
      {bar.run.final_text_chars !== null && <div className="dim">answer {bar.run.final_text_chars.toLocaleString()} characters · click to open</div>}
    </div>
  )
}

/** A lane's bot, playing where its agent stands now: a participant's current run (the same state as its card and its
 *  outline row), the director's own state on the dispatcher's lane. The lane's `data-state` stays the run's status. */
function LaneBot({ bot, runId, dispatcher }: { bot: string; runId: string | null; dispatcher: boolean }) {
  const run = useRunPresence(dispatcher ? null : runId)
  const director = useDirectorPresence(undefined)
  return <BotImage bot={bot} state={dispatcher ? director : run} />
}

/** A lane's state word: its latest run's status as the lane says it (`data-state` keeps the status), unless the
 *  agent's state says more in the same word's place — waiting (a slot, its folder, a watch), "needs you" (a form, an
 *  approval) — the word its card and its conversation's head say. */
function LaneWord({ runId, status }: { runId: string; status: string }) {
  const state = useRunPresence(runId)
  const said = cardStateWord({ status, receipt: useStore.getState().tree.find((r) => r.id === runId)?.receipt }, state)
  const word = said === 'waiting' || said === 'needs you' ? said : stateWord(status)
  return <b className={`rg-lane-state is-${status}`} data-testid="rg-lane-state">{word}</b>
}
