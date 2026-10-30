/** A share's Agent Teams card: the app's desk dock (DeskFrame — the card's own frame, title, meta and window buttons)
 *  around the app's outline (OutlineView), drawn from the team the share carries (../team.ts) — read-only. It sits
 *  where the app's dock sits by default (the desk's bottom right, its default size) and does not move: no drag, no
 *  resize, no card brought to the front, nothing asked of anyone. Its buttons act on this page alone: Shelve folds it to
 *  its title bar, Expand fills the thread with it. A click on a row lights its chain and scrolls the thread to its turn
 *  (focusTurn, the app's own glide), when the share holds that turn. */

import { memo, useCallback, useMemo, useRef, useState } from 'react'
import type { ShareTeam } from '@oasis-code/contract'
import { DeskButtons, DeskFrame, teamsMeta } from '../../components/DeskFrame'
import { OutlineView, type OutlineItem, type UseRowState } from '../../components/OutlineView'
import type { BotStill } from '../../components/BotImage'
import { LayersIcon } from '../../components/icons'
import { focusTurn } from '../../components/focusTurn'
import { keepUnchanged } from '../../state/lineage'
import { teamItems, teamRowState } from '../team'

const useShareRowState: UseRowState = (row) => teamRowState(row)

/** narrower than this, the card starts folded (the thread keeps the page) */
const NARROW = 720

export const TeamCard = memo(function TeamCard({ team, title, botStill }: {
  team: ShareTeam; title: string
  /** the stills the page carries: every bot of the card is one of them, whatever its row's state (never an animation,
   *  never a path of the app — the card may stand outside the thread's presentation) */
  botStill: BotStill
}) {
  // a team sent again keeps every row that did not change (its row is not drawn again)
  const kept = useRef<OutlineItem[] | null>(null)
  const rows = useMemo(() => (kept.current = keepUnchanged(kept.current, teamItems(team))), [team])
  const turns = useMemo(() => new Map(team.rows.map((r) => [r.key, r.turn])), [team])
  const [picked, setPicked] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < NARROW)
  const [expanded, setExpanded] = useState(false)
  const open = useCallback((row: OutlineItem) => {
    setPicked(row.id)
    const turn = turns.get(row.id)
    if (turn) focusTurn(turn)
  }, [turns])
  const selected = picked && turns.has(picked) ? picked : null
  return (
    <div className="desk-layer share-desk" data-testid="share-desk">
      <DeskFrame kind="graph" id="graph" depth={0} expanded={expanded} collapsed={collapsed && !expanded} title="Agent Teams" icon={<LayersIcon size={13} />}
                 meta={<span className="desk-state">{teamsMeta(team.agents, team.live)}</span>} bodyClass="graph-body" testId="graph-dock"
                 controls={<DeskButtons expanded={expanded} onShelve={() => { setExpanded(false); setCollapsed((c) => !c) }} onExpand={() => { setCollapsed(false); setExpanded((x) => !x) }} />}
                 onTitleDoubleClick={() => { setCollapsed(false); setExpanded((x) => !x) }}>
        <OutlineView title={title} rows={rows} selected={selected} onOpen={open} useRowState={useShareRowState} botStill={botStill} />
      </DeskFrame>
    </div>
  )
})
