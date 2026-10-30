import { create } from 'zustand'

/** The desk (carried from oasis state/desk.ts, see NOTICE): the thread is the main surface; every agent's card and
 *  the workspace card are ONE STACK that sits in a corner — the front card whole, the ones behind it stepped back
 *  so their titles peek out. Clicking a card brings it to the front, dragging the stack carries it to another
 *  corner (it snaps and glides there), the front card's edges resize every card. The agent graph is a dock of its
 *  own that snaps to corners the same way. A card can be shelved to a chip or expanded to fill the desk. Pure
 *  state; the components read and write it; the corners and the card size are remembered per session. */

export type DeskKind = 'run' | 'graph' | 'workspace' | 'chatgpt' | 'browser'
export type Corner = 'tr' | 'br' | 'tl' | 'bl'
/** How the cards behind the front one are arranged: `column` — a column of title strips under the whole front
 *  card, the default; `cascade` — stepped diagonally toward the desk's centre; `grid` — every card whole, tiled
 *  from the corner and shrunk to fit, a wall for watching every agent at once. */
export type StackMode = 'column' | 'cascade' | 'grid'

export interface DeskWindow {
  id: string
  kind: DeskKind
  runId?: string
  /** stacking order: the highest is the front card */
  z: number
  /** shelved: a chip, not a card */
  min: boolean
}

export interface Size { w: number; h: number }

/** A run to bring into view on its card: the card's window, and a counter so the same run asked again scrolls again. */
export interface CardFocus { windowId: string; runId: string; nonce: number }

interface DeskState {
  sessionId: string | null
  windows: Record<string, DeskWindow>
  expanded: string | null
  zTop: number
  stackCorner: Corner
  graphCorner: Corner
  stackMode: StackMode
  card: Size
  graph: Size
  /** the run a card brings into view (a jump from the thread's summary, the relations, a step's button) */
  focused: CardFocus | null
  /** runs asked for before their card exists (the tree not read yet), by run id with when they were asked: shown as
   *  soon as the card appears, never dropped by the desk's tidying meanwhile */
  pendingReveal: Record<string, number>
  /** cards a jump brought back, by window id with when: the desk's shelving as a session opens leaves them out */
  revealed: Record<string, number>
  /** take a card back from the shelf, bring it to the front, and its run into view */
  reveal: (windowId: string, runId: string) => void
  waitReveal: (runId: string, at: number) => void
  dropPending: (runIds: string[]) => void
  setStackMode: (mode: StackMode) => void
  /** Load the remembered desk of a session (or start empty). */
  openSession: (sessionId: string | null) => void
  /** Make sure a card exists; a new one goes to the front. */
  ensure: (id: string, kind: DeskKind, runId?: string) => void
  focus: (id: string) => void
  setMin: (id: string, min: boolean) => void
  expand: (id: string | null) => void
  forget: (id: string) => void
  setStackCorner: (corner: Corner) => void
  setGraphCorner: (corner: Corner) => void
  setCardSize: (size: Size) => void
  setGraphSize: (size: Size) => void
}

const STACK_MODE_KEY = 'oasis-code.stackMode'
const DESK_KEY = (sessionId: string) => `oasis-code.desk.${sessionId}`
const CORNERS: Corner[] = ['tr', 'br', 'tl', 'bl']
const DEFAULT_CARD: Size = { w: 420, h: 340 }
const DEFAULT_GRAPH: Size = { w: 300, h: 260 }

interface Persisted {
  windows: Record<string, DeskWindow>
  stackCorner: Corner
  graphCorner: Corner
  card: Size
  graph: Size
}

function readStackMode(): StackMode {
  try {
    const raw = localStorage.getItem(STACK_MODE_KEY)
    return raw === 'cascade' || raw === 'grid' ? raw : 'column'
  } catch { return 'column' }
}

const EMPTY_DESK: Persisted = { windows: {}, stackCorner: 'tr', graphCorner: 'br', card: DEFAULT_CARD, graph: DEFAULT_GRAPH }

function readDesk(sessionId: string): Persisted {
  try {
    const raw = localStorage.getItem(DESK_KEY(sessionId))
    if (!raw) return EMPTY_DESK
    const parsed = JSON.parse(raw) as Partial<Persisted>
    const windows: Record<string, DeskWindow> = {}
    for (const [id, w] of Object.entries(parsed.windows ?? {})) {
      if (w && typeof w === 'object' && typeof (w as DeskWindow).kind === 'string') {
        windows[id] = { id, kind: (w as DeskWindow).kind, runId: (w as DeskWindow).runId, z: Number((w as DeskWindow).z) || 1, min: (w as DeskWindow).min === true }
      }
    }
    const size = (s: unknown, d: Size): Size => (s && typeof s === 'object' && typeof (s as Size).w === 'number' && typeof (s as Size).h === 'number'
      ? { w: Math.max(240, (s as Size).w), h: Math.max(160, (s as Size).h) } : d)
    return {
      windows,
      stackCorner: CORNERS.includes(parsed.stackCorner as Corner) ? (parsed.stackCorner as Corner) : 'tr',
      graphCorner: CORNERS.includes(parsed.graphCorner as Corner) ? (parsed.graphCorner as Corner) : 'br',
      card: size(parsed.card, DEFAULT_CARD),
      graph: size(parsed.graph, DEFAULT_GRAPH),
    }
  } catch { return EMPTY_DESK }
}

function persist(s: Pick<DeskState, 'sessionId' | 'windows' | 'stackCorner' | 'graphCorner' | 'card' | 'graph'>) {
  if (!s.sessionId) return
  const body: Persisted = { windows: s.windows, stackCorner: s.stackCorner, graphCorner: s.graphCorner, card: s.card, graph: s.graph }
  try { localStorage.setItem(DESK_KEY(s.sessionId), JSON.stringify(body)) } catch { /* private window */ }
}

export const useDesk = create<DeskState>((set, get) => ({
  sessionId: null,
  windows: {},
  expanded: null,
  zTop: 1,
  stackCorner: 'tr',
  graphCorner: 'br',
  stackMode: readStackMode(),
  card: DEFAULT_CARD,
  graph: DEFAULT_GRAPH,
  focused: null,
  pendingReveal: {},
  revealed: {},

  reveal: (windowId, runId) => {
    const s = get()
    if (!s.windows[windowId]) s.ensure(windowId, 'run', windowId.startsWith('run:') ? windowId.slice(4) : undefined)
    if (get().windows[windowId]?.min) get().setMin(windowId, false)
    get().focus(windowId)
    const pending = { ...get().pendingReveal }
    delete pending[runId]
    set({ focused: { windowId, runId, nonce: (get().focused?.nonce ?? 0) + 1 }, pendingReveal: pending, revealed: { ...get().revealed, [windowId]: Date.now() } })
  },
  waitReveal: (runId, at) => set({ pendingReveal: { ...get().pendingReveal, [runId]: at } }),
  dropPending: (runIds) => {
    if (!runIds.some((id) => id in get().pendingReveal)) return
    const pending = { ...get().pendingReveal }
    for (const id of runIds) delete pending[id]
    set({ pendingReveal: pending })
  },

  setStackMode: (stackMode) => {
    try { localStorage.setItem(STACK_MODE_KEY, stackMode) } catch { /* ignore */ }
    set({ stackMode })
  },
  openSession: (sessionId) => {
    if (sessionId === get().sessionId) return
    const desk = sessionId ? readDesk(sessionId) : EMPTY_DESK
    const zTop = Object.values(desk.windows).reduce((m, w) => Math.max(m, w.z), 1)
    set({ sessionId, expanded: null, zTop, focused: null, pendingReveal: {}, revealed: {}, ...desk })
  },
  ensure: (id, kind, runId) => {
    if (get().windows[id]) return
    set((s) => {
      const z = s.zTop + 1
      const next = { ...s, windows: { ...s.windows, [id]: { id, kind, runId, z, min: kind === 'graph' } }, zTop: z }
      persist(next)
      return { windows: next.windows, zTop: z }
    })
  },
  focus: (id) => set((s) => {
    const win = s.windows[id]
    if (!win || win.z === s.zTop) return {}
    const z = s.zTop + 1
    const next = { ...s, windows: { ...s.windows, [id]: { ...win, z } }, zTop: z }
    persist(next)
    return { windows: next.windows, zTop: z }
  }),
  setMin: (id, min) => set((s) => {
    const win = s.windows[id]
    if (!win) return {}
    const next = { ...s, windows: { ...s.windows, [id]: { ...win, min } } }
    persist(next)
    return { windows: next.windows, expanded: s.expanded === id && min ? null : s.expanded }
  }),
  expand: (id) => set((s) => {
    if (id && s.windows[id]?.min) {
      const next = { ...s, windows: { ...s.windows, [id]: { ...s.windows[id], min: false } } }
      persist(next)
      return { windows: next.windows, expanded: id }
    }
    return { expanded: id }
  }),
  forget: (id) => set((s) => {
    if (!s.windows[id]) return {}
    const windows = { ...s.windows }
    delete windows[id]
    persist({ ...s, windows })
    return { windows, expanded: s.expanded === id ? null : s.expanded }
  }),
  setStackCorner: (corner) => set((s) => { const next = { ...s, stackCorner: corner }; persist(next); return { stackCorner: corner } }),
  setGraphCorner: (corner) => set((s) => { const next = { ...s, graphCorner: corner }; persist(next); return { graphCorner: corner } }),
  setCardSize: (size) => set((s) => {
    const card = { w: Math.round(Math.max(240, size.w)), h: Math.round(Math.max(160, size.h)) }
    const next = { ...s, card }; persist(next); return { card }
  }),
  setGraphSize: (size) => set((s) => {
    const graph = { w: Math.round(Math.max(220, size.w)), h: Math.round(Math.max(140, size.h)) }
    const next = { ...s, graph }; persist(next); return { graph }
  }),
}))

/** The run whose card is at the front of the stack (shelved cards excluded). */
export function frontRun(windows: Record<string, DeskWindow>): string | null {
  let front: DeskWindow | null = null
  for (const w of Object.values(windows)) if (w.kind === 'run' && !w.min && w.runId && (!front || w.z > front.z)) front = w
  return front?.runId ?? null
}

/** The agents' cards a session's desk puts away as it opens: each one whose agent is at rest (`resting` says which
 *  runs are), so what stands in view is the work still going on; a card put away comes back from the shelf's chip. A
 *  card a jump brought into view (`revealed`) stays. */
/** The cards a stack too deep for its desk puts on the shelf: the oldest finished child cards first (the workspace,
 *  the thread's own agent and live runs stay); on a narrow desk, anything behind the front card that does not fit goes
 *  too. Never the front card — the one just brought forward (a jump, a click) is what the person asked to see. */
export function cardsOverflowing<W extends { id: string }>(stack: W[], resting: (w: W) => boolean, maxDepth: number, narrow: boolean): W[] {
  const over = stack.length - (maxDepth + 1)
  if (over <= 0) return []
  const behind = stack.slice(1).reverse()
  const spare = behind.filter(resting)
  return (narrow ? [...spare, ...behind.filter((w) => !spare.includes(w))] : spare).slice(0, over)
}

export function cardsAtRest(windows: Record<string, DeskWindow>, resting: (runId: string) => boolean, revealed: Record<string, number> = {}): string[] {
  return Object.values(windows).filter((w) => w.kind === 'run' && !w.min && !!w.runId && resting(w.runId) && !(w.id in revealed)).map((w) => w.id)
}

/** How long a jump waits for its run's card to appear (the tree read again) before it is given up. */
export const REVEAL_WAIT_MS = 30_000

/** The jumps waiting for a card, settled against the cards there are now: those whose card exists (to show), those
 *  still waiting, those given up (too old). `cardOf` is cardIdForRun over the desk's agents. */
export function settleReveals(pending: Record<string, number>, cardOf: (runId: string) => string | null, now: number): { show: { runId: string; windowId: string }[]; expired: string[] } {
  const show: { runId: string; windowId: string }[] = []
  const expired: string[] = []
  for (const [runId, at] of Object.entries(pending)) {
    const windowId = cardOf(runId)
    if (windowId) show.push({ runId, windowId })
    else if (now - at > REVEAL_WAIT_MS) expired.push(runId)
  }
  return { show, expired }
}

/** The nearest corner to a point on a desk of the given size. */
export function nearestCorner(x: number, y: number, width: number, height: number): Corner {
  const right = x > width / 2, bottom = y > height / 2
  return right ? (bottom ? 'br' : 'tr') : (bottom ? 'bl' : 'tl')
}

export interface Placed {
  x: number
  y: number
  w: number
  h: number
  /** 0 for the front card and for every tile of a grid */
  depth: number
  /** a title strip in a column */
  collapsed: boolean
}

/** How far each card behind the front one steps back in a cascade. */
export const STEP = { x: 44, y: 34 }
/** A card's title bar: the height of a strip in a column. */
export const TITLE_H = 34
/** The tail row under the stack: the "+N" chip and the arrangement pill. */
export const TAIL_H = 30
const COLUMN_GAP = 8
export const GAP = 12
const MIN_TILE_W = 160

/** Cards behind the front one that still show; deeper ones are shelved. */
export function maxDepthFor(mode: StackMode): number {
  return mode === 'column' ? 8 : mode === 'grid' ? 64 : 5
}

/** The grid that fits `count` tiles of the card's aspect into the desk (the tail row's height kept free): the
 *  column count that gives the largest tile, never larger than the card itself. */
export function fitGrid(count: number, card: Size, width: number, height: number): { cols: number; rows: number; w: number; h: number } {
  const n = Math.max(1, count)
  const areaW = width - 2 * GAP, areaH = height - 2 * GAP - TAIL_H - GAP
  const aspect = card.w / card.h
  let best = { cols: 1, rows: n, w: 0, h: 0 }
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols)
    let w = Math.min(card.w, (areaW - (cols - 1) * GAP) / cols)
    let h = Math.min(card.h, (areaH - (rows - 1) * GAP) / rows)
    if (w / aspect > h) w = h * aspect
    else h = w / aspect
    if (w >= best.w) best = { cols, rows, w, h }
  }
  const w = Math.max(MIN_TILE_W, Math.floor(best.w))
  return { cols: best.cols, rows: best.rows, w, h: Math.floor(w / aspect) }
}

/** The composer's box on the desk, which a bottom card beside it need not clear: its right edge from the desk's left
 *  and its height from the desk's bottom. A card reaching left of that edge stops above the composer; a card wholly
 *  to its right goes down to the desk's bottom. */
export interface Keepout { right: number; h: number }

/** The lowest a card's bottom edge may sit (before the gap), for a card whose left edge is at `x`. */
export function floorAt(x: number, height: number, keep: Keepout | null): number {
  return keep !== null && x < keep.right + GAP ? height - keep.h : height
}

/** The cards' places for a stack in a corner: the front card (depth 0) in the corner itself, whole; behind it, in
 *  a `column`, title strips running away from the corner; in a `cascade`, each card stepped diagonally toward the
 *  desk's centre; in a `grid`, every card whole, tiled from the corner. */
export function placeStack(count: number, corner: Corner, card: Size, width: number, height: number, mode: StackMode, keep: Keepout | null = null): Placed[] {
  const right = corner === 'tr' || corner === 'br'
  const bottom = corner === 'br' || corner === 'bl'
  const out: Placed[] = []
  if (mode === 'grid') {
    const tile = fitGrid(count, card, width, height)
    for (let i = 0; i < count; i += 1) {
      const col = i % tile.cols, row = Math.floor(i / tile.cols)
      const x = right ? width - GAP - (col + 1) * tile.w - col * GAP : GAP + col * (tile.w + GAP)
      out.push({ x, y: bottom ? floorAt(x, height, keep) - GAP - (row + 1) * tile.h - row * GAP : GAP + row * (tile.h + GAP),
                 w: tile.w, h: tile.h, depth: 0, collapsed: false })
    }
    return out
  }
  const frontX = right ? width - GAP - card.w : GAP
  const frontY = bottom ? floorAt(frontX, height, keep) - GAP - card.h : GAP
  for (let i = 0; i < count; i += 1) {
    const depth = Math.min(i, maxDepthFor(mode))
    if (mode === 'column') {
      if (depth === 0) { out.push({ x: frontX, y: frontY, w: card.w, h: card.h, depth, collapsed: false }); continue }
      const pitch = TITLE_H + COLUMN_GAP
      const y = bottom ? frontY - depth * pitch : frontY + card.h + COLUMN_GAP + (depth - 1) * pitch
      out.push({ x: frontX, y, w: card.w, h: TITLE_H, depth, collapsed: true })
    } else {
      out.push({ x: right ? frontX - depth * STEP.x : frontX + depth * STEP.x,
                 y: bottom ? frontY - depth * STEP.y : frontY + depth * STEP.y, w: card.w, h: card.h, depth, collapsed: false })
    }
  }
  return out
}

/** Where the shelf's "+N" chip hangs: the place of the card that would come after the stack's last one. */
export function placeTail(count: number, corner: Corner, card: Size, width: number, height: number, mode: StackMode, keep: Keepout | null = null): { x: number; y: number } {
  const right = corner === 'tr' || corner === 'br'
  const bottom = corner === 'br' || corner === 'bl'
  if (mode === 'grid') {
    const tile = fitGrid(count, card, width, height)
    const rows = count === 0 ? 0 : tile.rows
    const x = right ? width - GAP - tile.w : GAP
    return { x, y: bottom ? floorAt(x, height, keep) - GAP - rows * (tile.h + GAP) - TAIL_H : GAP + rows * (tile.h + GAP) }
  }
  if (count === 0 || mode === 'column') {
    const next = placeStack(count + 1, corner, card, width, height, mode, keep)[count]
    const y = bottom ? Math.max(GAP, next.y) : Math.min(next.y, height - GAP - TAIL_H)
    return { x: next.x, y }
  }
  const last = placeStack(count, corner, card, width, height, mode, keep)[count - 1]
  return { x: last.x + (right ? -STEP.x : STEP.x), y: last.y + (bottom ? -STEP.y : STEP.y) }
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** A card in a corner is resized from any edge or corner, and the rule is the corner's: the hand moving away from
 *  the corner makes the card larger, toward the corner smaller. */
export function resizeFrom(edge: ResizeEdge, corner: Corner, start: Size, dx: number, dy: number): Size {
  const right = corner === 'tr' || corner === 'br'
  const bottom = corner === 'br' || corner === 'bl'
  const horizontal = edge.includes('e') || edge.includes('w')
  const vertical = edge.includes('n') || edge.includes('s')
  return { w: horizontal ? start.w + (right ? -dx : dx) : start.w, h: vertical ? start.h + (bottom ? -dy : dy) : start.h }
}

/** The desk as it can be used at its size (a narrow window: the desktop app allows 720 wide, the rail 260 of it):
 *  the card and the dock never wider than the desk; and when the two cannot sit side by side, the dock takes the
 *  vertical end opposite the stack and the front card is cut to clear it, with only as many strips under it as fit
 *  (the rest go to the shelf). A dock put away on the shelf takes no height. The person's own sizes and corners are
 *  kept; this is how they are shown here. */
export interface DeskFit {
  card: Size
  graph: Size
  stackCorner: Corner
  graphCorner: Corner
  /** the desk is too narrow for the stack and the dock side by side */
  narrow: boolean
  /** cards behind the front one that still show */
  maxDepth: number
}

const MIN_CARD: Size = { w: 220, h: 140 }
const MIN_GRAPH: Size = { w: 220, h: 160 }

export function fitDesk(card: Size, graph: Size, stackCorner: Corner, graphCorner: Corner, mode: StackMode, width: number, height: number, keep: Keepout | null = null, count = 1, dock = true): DeskFit {
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(v, Math.max(lo, hi))))
  const usableW = width - 2 * GAP
  const usableH = height - 2 * GAP
  let cardW = clamp(card.w, MIN_CARD.w, usableW)
  let cardH = clamp(card.h, MIN_CARD.h, usableH - TAIL_H - GAP)
  let graphW = clamp(graph.w, MIN_GRAPH.w, usableW)
  let graphH = clamp(graph.h, MIN_GRAPH.h, usableH)
  const narrow = cardW + graphW + 3 * GAP > width
  let nextGraph = graphCorner
  let maxDepth = maxDepthFor(mode)
  const pitch = mode === 'column' ? TITLE_H + COLUMN_GAP : mode === 'cascade' ? STEP.y : 0
  // the stack shares a height with the dock: the front card gives up height for the strips of the cards behind it
  // (up to two) before any goes to the shelf; the strips that still fit, no more
  const share = (budget: number) => {
    const wanted = Math.min(Math.max(0, count - 1), 2, maxDepth)
    cardH = clamp(Math.min(card.h, budget - GAP - wanted * pitch), MIN_CARD.h, Math.max(MIN_CARD.h, budget - GAP))
    const strips = pitch > 0 ? Math.max(0, Math.floor((budget - GAP - cardH) / pitch)) : maxDepth
    maxDepth = Math.min(maxDepth, strips)
  }
  const isRight = (c: Corner) => c === 'tr' || c === 'br'
  const isBottom = (c: Corner) => c === 'br' || c === 'bl'
  if (dock && !narrow && mode !== 'grid' && isRight(stackCorner) === isRight(graphCorner) && isBottom(stackCorner) !== isBottom(graphCorner)) {
    // a wide desk with the stack and the dock on one side, one above the other (the default: the stack top right, the
    // dock bottom right): they share that side's height as on a narrow desk, the dock where and as large as it is
    const lower = isBottom(stackCorner) ? { w: cardW, corner: stackCorner } : { w: graphW, corner: graphCorner }
    const floor = floorAt(isRight(lower.corner) ? width - GAP - lower.w : GAP, height, keep)
    share(floor - graphH - 3 * GAP - TAIL_H)
  }
  if (narrow) {
    // one above the other: the stack keeps its end, the dock takes the other; the dock at most two fifths of the
    // height, the front card what is left above (or below) it, less the strips that still fit
    const stackBottom = stackCorner === 'br' || stackCorner === 'bl'
    const graphRight = graphCorner === 'tr' || graphCorner === 'br'
    nextGraph = stackBottom ? (graphRight ? 'tr' : 'tl') : (graphRight ? 'br' : 'bl')
    graphH = clamp(Math.min(graph.h, Math.floor(height * 0.4)), MIN_GRAPH.h, usableH)
    // whichever of the two sits at the bottom clears the composer (the keepout spans a narrow desk)
    const keepH = keep !== null ? keep.h : 0
    share(height - (dock ? graphH + GAP : 0) - keepH - 2 * GAP - TAIL_H)
  }
  return { card: { w: cardW, h: cardH }, graph: { w: graphW, h: graphH }, stackCorner, graphCorner: nextGraph, narrow, maxDepth }
}

/** Where a single dock (the graph) sits in its corner. */
/** The card's own size once the dock beside it is put away: the height it was shown at there (the card does not move;
 *  the freed height is the person's to drag it into), or null when its own size is no taller. */
export function cardKeptOnUndock(shownDocked: Size | null, card: Size): Size | null {
  return shownDocked !== null && shownDocked.h < card.h ? { w: card.w, h: shownDocked.h } : null
}

export function placeDock(corner: Corner, size: Size, width: number, height: number, keep: Keepout | null = null): { x: number; y: number } {
  const right = corner === 'tr' || corner === 'br'
  const bottom = corner === 'br' || corner === 'bl'
  const x = right ? width - GAP - size.w : GAP
  return { x, y: bottom ? floorAt(x, height, keep) - GAP - size.h : GAP }
}

/** When a card brings the run a jump asked for into view: as soon as the run's turn is on the card (`first`), and once
 *  more when every run of the card up to it has its rows (`settled`: the turns above it read, so it stands where it
 *  will stay) — at most those two for one ask, so a live stream that grows never pulls the card back; a later ask
 *  (another nonce) starts again. `handled`: what was done for which ask. */
export type FocusPhase = 'first' | 'settled'
export function focusStep(handled: { nonce: number; phase: FocusPhase } | null, focused: CardFocus | null, present: boolean, settled: boolean): FocusPhase | null {
  if (!focused || !present) return null
  if (!handled || handled.nonce !== focused.nonce) return settled ? 'settled' : 'first'
  return handled.phase === 'first' && settled ? 'settled' : null
}
