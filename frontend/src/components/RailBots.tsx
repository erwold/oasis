import type { ReactNode } from 'react'
import type { SessionDot } from '../state/sessionDots'
import { BotImage, type BotStill } from './BotImage'

/** At most this many bots stand in a row's stack (the rail sizes its column by it). */
export const RAIL_BOTS_SHOWN = 3

/** The bots of the agents that took part in a session, stacked: the first on top, the next ones peeking out behind it
 *  (at most three; more are said in the title). */
export function RailBots({ bots, still }: { bots: readonly string[]; /** a share's page: the stills it carries */ still?: BotStill }) {
  const shown = bots.slice(0, RAIL_BOTS_SHOWN)
  return (
    <span className="rail-bots" data-count={shown.length} title={bots.length > shown.length ? `${bots.length} agents` : undefined} data-testid="rail-bots">
      {shown.map((bot, i) => <span key={bot} className="rail-bot-slot" style={{ zIndex: shown.length - i }}><BotImage bot={bot} size={16} still={still} /></span>)}
    </span>
  )
}

/** A conversation's entry in the rail as it is drawn: its bots stacked, its title, what stands beside it (the folder
 *  it works in when that is not its task's), its dot (state/sessionDots.ts: running, or ended unseen). Pure: the rail
 *  (Sidebar.tsx) and a share's list of the task's sessions draw it alike; what a click does is theirs. */
export function RailSessionButton({ title, tooltip = title, bots, on, meta = null, dot = null, dotTestId, onClick, testId, botStill }: {
  title: string
  tooltip?: string
  bots: readonly string[]
  on: boolean
  meta?: ReactNode
  dot?: SessionDot
  dotTestId?: string
  onClick: () => void
  testId?: string
  /** a share's page: its bots drawn from the stills it carries */
  botStill?: BotStill
}) {
  return (
    <button className={`nav-item rail-session${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined} title={tooltip} onClick={onClick} data-testid={testId}>
      <RailBots bots={bots} still={botStill} />
      <span className="nav-label">{title}</span>
      {meta}
      {dot && <span className={`rail-dot rail-dot-${dot}`} role="img" aria-label={dot === 'running' ? 'Running' : 'Ended, not viewed yet'} data-testid={dotTestId} data-dot={dot} />}
    </button>
  )
}
