import { memo, useCallback, useMemo, useRef, useState } from 'react'
import type { RunTreeRow } from '../api/types'
import { useDesk, frontRun } from '../state/desk'
import { foldAgents, foldLineages, isThreadRow, keepUnchanged, withDependencies } from '../state/lineage'
import type { Lineage } from '../state/lineage'
import { botFor, glyphFor, glyphTitle, isActionRow, nameOf, waitingOf, type Glyph } from '../state/outline'
import { useStore } from '../state/store'
import { useRunPresence } from './BotImage'
import { OutlineView, type OutlineItem, type UseRowState } from './OutlineView'
import { revealRun } from './Desk'
import { focusTurn } from './focusTurn'

/** The outline (carried from oasis components/AgentOutline.tsx, see NOTICE): one row per piece of work — a run, a
 *  plan's node not started yet, the director's plan, the decision that is the person's — indented under whoever
 *  scheduled it, the session as the folder, like Blender's outliner. A run that continues another folds into its
 *  row; a plan node stands on its own with its participant's letter on its bot (the bot its chip wears), so one
 *  participant's two steps read as two rows of one A. Its name is the order's label or the person's first line; its
 *  right side says what it is doing: the run's id, its duration and the glyph the receipt measured; `running`;
 *  `waits B, C` while it waits; `sleeping` for a director whose plan runs; `after A` / `needs you` for the decision.
 *  A hairline runs from each parent's icon into its child's, in the child's colour (who scheduled whom); a dashed
 *  line at the right edge runs from a row to the row that waits for it (who waits for whom — never who read whom);
 *  the selected chain and the edges into and out of the selected row light up. It is the desk's Agent Teams dock: a
 *  click brings the agent's card to the front; a plan's own row scrolls the thread to its board. */

/** A plan's own row opens nothing: the thread scrolls to the plan's board. */
function scrollToBoard(row: Lineage): void {
  const target = row.interaction_id ? document.querySelector(`[data-testid="interaction-${row.interaction_id}"]`) : document.querySelector('[data-testid="relay-board"]')
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/** A lineage as the outline draws it, kept for the lineage object (a tree read again keeps every row that did not
 *  change, so its item is the same object and its row is not drawn again). */
const ITEMS = new WeakMap<Lineage, OutlineItem>()
/** the run whose state an item's bot plays (the lineage's newest) */
const LATEST = new WeakMap<OutlineItem, RunTreeRow>()

export function outlineItemOf(row: Lineage): OutlineItem {
  const held = ITEMS.get(row)
  if (held) return held
  // a plan's own rows: a person's stop is no failure (no red); only an error is
  const glyph: Glyph = row.kind === 'run' ? glyphFor(row) : row.status === 'error' ? 'err' : row.status === 'done' ? 'done' : null
  const item: OutlineItem = {
    id: row.id, parent_run_id: row.parent_run_id, scheduled_by: row.scheduled_by, depends_on: row.depends_on, kind: row.kind, status: row.status,
    bot: botFor(row), name: nameOf(row), model: row.model, participant_index: row.participant_index ?? null, participant_name: row.participant_name ?? null,
    participant_alias: row.participant_alias ?? null, runs: row.lineage.length, created_at: row.created_at, finished_at: row.finished_at,
    glyph, glyph_title: glyphTitle(row, glyph), ref: row.id,
    // queued behind what holds its folder (the row's `waiting`, when the tree carries it)
    lock: row.status === 'queued' ? waitingOf((row as { waiting?: unknown }).waiting) : null,
  }
  ITEMS.set(row, item)
  LATEST.set(item, row.latest)
  return item
}

/** its bot as its current run stands (state/presence.ts): read for that run alone */
const useRowState: UseRowState = (item) => useRunPresence(LATEST.get(item) ?? item.id)

/** The desk's Agent Teams dock: the session's runs in the outline (OutlineView.tsx). A click brings the agent's card to
 *  the front; a plan's own row scrolls the thread to its board. The outline draws for what it shows alone (a memo: the
 *  desk drawing again, on its clock or for a card, does not draw it). The tree read again keeps every run that did not
 *  change, and the whole tree when none did: nothing under it is folded or laid out again for a tree that only came
 *  back the same. */
export const AgentOutline = memo(function AgentOutline() {
  const session = useStore((s) => s.session)
  const read = useStore((s) => s.tree)
  const keptTree = useRef<RunTreeRow[] | null>(null)
  const tree = useMemo(() => (keptTree.current = keepUnchanged(keptTree.current, read)), [read])
  // the agents' runs make the tree; the actions taken beside them (a command, an integration) stand in the thread.
  // A tree read again keeps every row that did not change (its row draws again only when it did)
  const kept = useRef<Lineage[] | null>(null)
  const rows = useMemo(() => {
    kept.current = keepUnchanged(kept.current, withDependencies(foldLineages(tree)).filter((r) => !isActionRow(r)))
    return kept.current
  }, [tree])
  const keptItems = useRef<OutlineItem[] | null>(null)
  const items = useMemo(() => {
    const next = rows.map(outlineItemOf)
    const prev = keptItems.current
    keptItems.current = prev && prev.length === next.length && next.every((x, i) => x === prev[i]) ? prev : next
    return keptItems.current
  }, [rows])
  // the desk's cards are agents (one per participant); the outline's rows are steps
  const agents = useMemo(() => foldAgents(tree), [tree])
  const watchChild = useStore((s) => s.watchChild)
  const front = useDesk((s) => frontRun(s.windows))
  // the row the person picked here; the front card alone names an agent, whose first step stands for it
  const [picked, setPicked] = useState<string | null>(null)
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  // the agent's card comes to the front (taken back from the shelf if need be), its stream watched; a plan's own
  // row (a node not started, the plan, the decision) has no card: the thread scrolls to the plan's board
  const open = useCallback((item: OutlineItem) => {
    const row = byId.get(item.id)
    if (!row) return
    setPicked(row.id)
    if (row.spawned_by === 'plan') { scrollToBoard(row); return }
    // the card that carries this step (a participant's later step is on its first step's card), at this step's run
    revealRun(row.latest.id)
    focusTurn(row.latest.id)                              // the thread glides to the step's answer, its line lights twice
    row.lineage.forEach((r) => { if (!isThreadRow(r) && r.spawned_by !== 'human_action') void watchChild(r.id) })
  }, [byId, watchChild])
  // the selected row: the one picked here while its agent's card is at the front, else that agent's first step
  const selected = useMemo(() => {
    if (!front) return null
    const runs = new Set((agents.find((a) => a.id === front)?.lineage ?? []).map((r) => r.id))
    if (!runs.size) runs.add(front)
    const carries = (r: Lineage | undefined) => !!r && r.lineage.some((x) => runs.has(x.id))
    if (picked && carries(byId.get(picked))) return picked
    return rows.find(carries)?.id ?? null
  }, [front, agents, picked, rows, byId])

  if (!session) return null
  return <OutlineView key={session.id} title={session.title} rows={items} selected={selected} onOpen={open} useRowState={useRowState} />
})
