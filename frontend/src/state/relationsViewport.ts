/** What of a long relations board is in the DOM: the lanes the thread's scroll shows and a few around them, the bars,
 *  steps and clocks on them, and the arrows with an end on them. The arrows that only pass the lanes shown (both ends
 *  off screen, or a dispatch to a lane under them) are not drawn but counted, in one line over the board — so what is
 *  drawn stays as long as the screen is tall, whatever the board's length. A board of no more than VIRTUAL_ABOVE lanes
 *  is drawn whole. Pure: RelationsGraph measures, this picks. */

import { AXIS_H, LANE_H, type Bar, type Ghost, type Lane, type Link, type LinkKind, type RelationsLayout, type WatchMark } from './relationsGraph.ts'

export const VIRTUAL_ABOVE = 40
/** lanes drawn above and under the visible ones, so a quick scroll does not show them blank */
export const OVERSCAN = 6

/** The lanes [first, last] (indices, inclusive) for a viewport of `height` px whose top is `top` px under the graph's
 *  top (negative: the graph starts below the viewport's top edge). */
export interface LaneRange { first: number; last: number }

export function laneRange(laneCount: number, top: number, height: number, overscan = OVERSCAN): LaneRange {
  if (laneCount === 0) return { first: 0, last: -1 }
  if (laneCount <= VIRTUAL_ABOVE) return { first: 0, last: laneCount - 1 }
  const at = (y: number): number => Math.floor((y - AXIS_H) / LANE_H)
  const first = Math.max(0, Math.min(laneCount - 1, at(top) - overscan))
  const last = Math.max(first, Math.min(laneCount - 1, at(top + Math.max(0, height)) + overscan))
  return { first, last }
}

export const sameRange = (a: LaneRange, b: LaneRange): boolean => a.first === b.first && a.last === b.last

/** The layout grouped by lane once, so a new range is picked without going over every bar again. */
export interface LayoutIndex {
  lanes: Lane[]
  bars: Bar[][]
  ghosts: Ghost[][]
  /** the arrows shown, each with the lanes (indices) it leaves and reaches */
  links: { link: Link; from: number; to: number }[]
  /** a run → the arrows shown that leave or reach it (the ones lit while the pointer is on its bar) */
  linksOfRun: Map<string, Link[]>
}

export function indexLayout(layout: RelationsLayout, shown: (link: Link) => boolean): LayoutIndex {
  const at = new Map(layout.lanes.map((l, i) => [l.id, i]))
  const bars: Bar[][] = layout.lanes.map(() => [])
  const ghosts: Ghost[][] = layout.lanes.map(() => [])
  for (const b of layout.bars) bars[at.get(b.lane)!]!.push(b)
  for (const g of layout.ghosts) ghosts[at.get(g.lane)!]!.push(g)
  const links: LayoutIndex['links'] = []
  const linksOfRun = new Map<string, Link[]>()
  const add = (run: string | null, link: Link) => {
    if (run === null) return
    const own = linksOfRun.get(run)
    if (own) own.push(link)
    else linksOfRun.set(run, [link])
  }
  for (const link of layout.links) {
    if (!shown(link)) continue
    links.push({ link, from: at.get(link.lane_from)!, to: at.get(link.lane_to)! })
    add(link.run_from, link)
    add(link.run_to, link)
  }
  return { lanes: layout.lanes, bars, ghosts, links, linksOfRun }
}

/** `passing`: by kind, the arrows not drawn that pass the lanes drawn */
export interface LaneView { lanes: Lane[]; bars: Bar[]; ghosts: Ghost[]; links: Link[]; marks: WatchMark[]; passing: Partial<Record<LinkKind, number>> }

/** What the range draws: its lanes with their bars and steps, the clocks on them, the arrows with an end on them. A
 *  dispatch is drawn with the bar it reaches: the dispatcher's one lane over everyone would otherwise start a vertical
 *  line for every agent under the screen. What passes the range without an end in it is counted. */
export function viewOf(index: LayoutIndex, marks: WatchMark[], range: LaneRange): LaneView {
  const lanes = index.lanes.slice(range.first, range.last + 1)
  const ids = new Set(lanes.map((l) => l.id))
  const inRange = (i: number): boolean => i >= range.first && i <= range.last
  const links: Link[] = []
  const passing: Partial<Record<LinkKind, number>> = {}
  const pass = (kind: LinkKind) => { passing[kind] = (passing[kind] ?? 0) + 1 }
  for (const { link, from, to } of index.links) {
    if (link.kind === 'dispatched') {
      if (inRange(to)) links.push(link)
      else if (from <= range.last && to > range.last) pass(link.kind)
    } else if (inRange(from) || inRange(to)) links.push(link)
    else if (Math.min(from, to) < range.first && Math.max(from, to) > range.last) pass(link.kind)
  }
  return {
    lanes,
    bars: index.bars.slice(range.first, range.last + 1).flat(),
    ghosts: index.ghosts.slice(range.first, range.last + 1).flat(),
    links,
    marks: marks.filter((m) => ids.has(m.lane)),
    passing,
  }
}

// the kinds the board draws (RelationsGraph's SHOWN), as the line counts them
const PASSING_WORDS: Partial<Record<LinkKind, [string, string]>> = {
  dispatched: ['dispatch to an agent below', 'dispatches to agents below'],
  received: ['handover', 'handovers'],
  cited: ['citation', 'citations'],
}

/** The line over a long board for what passes its lanes on screen undrawn; null when nothing does. */
export function passingLine(passing: Partial<Record<LinkKind, number>>): string | null {
  const parts = (Object.keys(PASSING_WORDS) as LinkKind[]).flatMap((k) => {
    const n = passing[k] ?? 0
    return n ? [`${n.toLocaleString('en-US')} ${PASSING_WORDS[k]![n === 1 ? 0 : 1]}`] : []
  })
  return parts.length ? `Not drawn here: ${parts.join(' · ')} — their ends are off screen` : null
}

/** The run under the pointer, outside React's state: the board does not draw again as the pointer moves. A listener
 *  hears only a change of run; `onMove` takes the pointer's place for whatever follows it by hand (the tooltip). */
export interface HoverChannel {
  run: () => string | null
  x: () => number
  set: (run: string | null, x: number) => void
  subscribe: (listener: () => void) => () => void
  onMove: (listener: (x: number) => void) => () => void
}

export function hoverChannel(): HoverChannel {
  let run: string | null = null
  let x = 0
  const listeners = new Set<() => void>()
  const moves = new Set<(x: number) => void>()
  return {
    run: () => run,
    x: () => x,
    set(next, nextX) {
      x = nextX
      if (next !== run) {
        run = next
        for (const l of listeners) l()
      } else for (const m of moves) m(x)
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    onMove(listener) { moves.add(listener); return () => { moves.delete(listener) } },
  }
}
