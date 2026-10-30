import { memo, useEffect, useState } from 'react'
import type { Lineage } from '../state/lineage'
import { busyOf, liveWord, LIVE_STATUSES, waitingOf, type BotState } from '../state/outline'
import { useReplay } from '../state/replay'
import { useStore } from '../state/store'
import { answerHead, elapsedText, stateTone, toolsDone, workOf } from './AgentPresentation'
import './AgentPresentation.css'

const NO_ENTRIES: never[] = []

/** A clock that ticks every `every` ms while `active` and the page is in view; a hidden page does not draw it (the
 *  first tick back in view brings it up to date). */
export function useVisibleClock(active: boolean, every = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => { if (!document.hidden) setNow(Date.now()) }
    tick()
    const timer = window.setInterval(tick, every)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [active, every])
  return now
}

/** A run's elapsed time, its own small clock: ticking while it runs (the card around it does not draw again), still
 *  once it ended; during a replay, at the cursor. */
export function AgentElapsed({ from, to, live }: { from: string; to: string | null; live: boolean }) {
  const cursor = useReplay((s) => (s.active ? s.cursor : null))
  const now = useVisibleClock(live && cursor === null)
  const end = to ? Date.parse(to) : cursor ?? now
  return <span className="ap-elapsed" data-testid="agent-elapsed">{elapsedText(end - Date.parse(from))}</span>
}

/** The line under an agent card's title (whose meta says its state): what it does now — the tool call still open,
 *  else what its model does, else its answer's first line — and its counts: tool calls ended, agents it started, its
 *  time. Every value read from the rows the page holds. */
export const AgentCardStrip = memo(function AgentCardStrip({ row, state, agents }: { row: Lineage; state: BotState; /** the agents it started, over its whole lineage, each once (subAgentCounts) */ agents: number }) {
  const latest = row.latest
  const pick = (s: ReturnType<typeof useStore.getState>) => s.childThreads[latest.id] ?? s.threads[latest.id] ?? NO_ENTRIES
  const work = useStore((s) => workOf(pick(s)))
  const tools = useStore((s) => toolsDone(pick(s)))
  const answer = useStore((s) => answerHead(pick(s)))
  const live = LIVE_STATUSES.has(row.status)
  const tone = stateTone(row.status)
  const said = live ? work ?? liveWord(state, waitingOf((latest as { waiting?: unknown }).waiting)) : answer
  return (
    <div className={`ap-strip tone-${tone}`} data-testid="agent-strip" data-state={state} data-status={row.status}>
      <span className={`ap-work${live && work ? ' is-tool' : ''}`} title={said ?? undefined}>{said ?? ''}</span>
      <span className="ap-nums">
        {tools > 0 && <span title="tool calls ended"><b>{tools}</b> tool{tools === 1 ? '' : 's'}</span>}
        {agents > 0 && <span title="agents it started"><b>{agents}</b> agent{agents === 1 ? '' : 's'}</span>}
        <AgentElapsed from={latest.created_at} to={latest.finished_at} live={live} />
      </span>
    </div>
  )
})

/** A live bar's head on the timeline: a hollow ring where the run stands now; a halo spreads from it only while the
 *  run's own rows say one of its tools runs (its stream watched by the page), never on a guess. */
export const LiveHead = memo(function LiveHead({ runId, x, y }: { runId: string; x: number; y: number }) {
  const busy = useStore((s) => busyOf(s.childThreads[runId] ?? s.threads[runId] ?? NO_ENTRIES))
  return (
    <g className="rg-live-head" data-testid={`rg-head-${runId}`} data-busy={busy ? 'true' : 'false'}>
      {busy && <circle className="rg-head-halo busy" cx={x} cy={y} r={4} />}
      <circle className="rg-head" cx={x} cy={y} r={3.5} />
    </g>
  )
})
