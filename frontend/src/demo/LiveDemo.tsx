/** The live UI demo page (`?demo=live-ui`): a SIMULATED training run and its four agents drawn by the product's own
 *  components — the intelligent-UI surfaces (UiSurfaceBlock), the Agent Teams outline (AgentOutline), the desk's agent
 *  cards (RunCard; the whole Desk in the Agents view) and the agents' timeline (AgentsBoard) — in one of two skins.
 *  The simulator ticks at 2 Hz; each tick is a new revision of the surfaces and new run rows, as the harness would
 *  send them. Nothing reaches the harness: the stores' actions are in memory (liveAdapter.ts) and the cards read an
 *  in-memory data source (liveDataSource.ts). */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RunTreeRow } from '@oasis-code/contract'
import { AgentOutline } from '../components/AgentOutline'
import { Desk, RunCard, type CardDataSource } from '../components/Desk'
import { AgentsBoard } from '../components/Thread'
import { UiSurfaceBlock } from '../components/UiSurface'
import { useAgents } from '../components/useCollab'
import { PauseIcon, PlayIcon, RotateCcwIcon } from '../components/icons'
import { useDesk, type Placed } from '../state/desk'
import type { Lineage } from '../state/lineage'
import { scopeToAgents } from '../state/relationsGraph'
import { useStore } from '../state/store'
import type { ThreadEntry } from '../state/thread'
import { createFeed, openDemoSession, publish, type FeedState, type Published } from './liveFeed'
import { CKPT_EVERY, EVAL_STEPS, TICK_MS, TOTAL_STEPS, advance, createSim, scheduleAt, type SimState, type Speed } from './liveSim'
import { TRAINER_RUN } from './liveFixtures'
import { createLiveDataSource } from './liveDataSource'
import './live-theme.css'

export type LiveTheme = 'atelier' | 'signal'
export type LiveTab = 'run' | 'agents'

export interface LiveOptions { theme: LiveTheme; tab: LiveTab; seed: number; speed: Speed; paused: boolean; warm: number; stress: boolean }

/** the skin a build opens with when the address names none (the two demo branches differ only here) */
export const DEFAULT_THEME: LiveTheme = 'atelier'

export function optionsFrom(search: string): LiveOptions {
  const q = new URLSearchParams(search)
  const num = (k: string, d: number) => { const v = Number(q.get(k)); return Number.isFinite(v) && q.has(k) ? v : d }
  const theme = q.get('theme')
  return {
    theme: theme === 'signal' || theme === 'atelier' ? theme : DEFAULT_THEME,
    tab: q.get('tab') === 'agents' ? 'agents' : 'run',
    seed: Math.trunc(num('seed', 14)),
    speed: q.get('speed') === '4' ? 4 : 1,
    paused: q.get('paused') === '1',
    warm: Math.max(0, Math.min(2_000, Math.trunc(num('warm', 0)))),
    stress: q.get('stress') === '1',
  }
}

/** the width an element has (it follows a resize) */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    if (!el) return
    const apply = () => setW(el.clientWidth)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, w]
}

const NO_KIDS: RunTreeRow[] = []
const noop = () => undefined

/** One agent's card where the page lays it out: the desk's own card, at rest in its slot (its body reads the demo's
 *  data source). */
function AgentCard({ row, clock, height, dataSource }: { row: Lineage; clock: number; height: number; dataSource: CardDataSource }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const id = `run:${row.id}`
  const win = useDesk((s) => s.windows[id])
  useEffect(() => { useDesk.getState().ensure(id, 'run', row.id) }, [id, row.id])
  const place = useMemo<Placed>(() => ({ x: 0, y: 0, w: Math.max(220, width), h: height, depth: 0, collapsed: false }), [width, height])
  return (
    <div className="live-card-slot" ref={ref} style={{ height }} data-testid={`live-card-${row.participant_alias ?? row.id}`}>
      {win && width > 0 && (
        <RunCard win={win} row={row} kids={NO_KIDS} place={place} dragging={false} resizing={false} clock={clock}
                 onTitlePointerDown={noop} onResizePointerDown={noop} elRef={noop} dataSource={dataSource} />
      )}
    </div>
  )
}

/** The whole desk where the agents view lays it out. Its first layout fits two columns of cards to the room the page
 *  leaves it (in the desk's memory only); a card dragged or resized afterwards is the person's. */
function DeskHost({ dataSource }: { dataSource: CardDataSource }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const fitted = useRef(false)
  useLayoutEffect(() => {
    if (fitted.current || width < 480) return
    fitted.current = true
    useDesk.getState().setCardSize({ w: Math.floor(width / 2) - 12, h: 340 })
  }, [width])
  return <div className="live-desk-host" ref={ref}>{width > 0 && <Desk dataSource={dataSource} />}</div>
}

function Seg<T extends string | number>({ value, options, onChange, label, testId }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string; testId: string }) {
  return (
    <div className="live-seg" role="group" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} className={o.value === value ? 'on' : undefined} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

const thousands = (n: number) => n.toLocaleString('en-US')
/** a card's height in the run view */
const CARD_H = 264

/** The demo's first state, made before the page draws (the stores hold its session and its first word by then). */
export interface LiveBoot { feed: FeedState; sim: SimState; out: Published }

export function bootLive(initial: LiveOptions, now = Date.now()): LiveBoot {
  let sim: SimState = { ...createSim(now - initial.warm * TICK_MS, initial.seed), speed: initial.speed }
  // warm: the run moves on that many ticks before the first frame (the same picture for the same seed and warm)
  for (let i = 0; i < initial.warm; i++) sim = advance(sim, now - (initial.warm - i) * TICK_MS)
  sim = { ...sim, paused: initial.paused }
  const feed = createFeed()
  openDemoSession()
  return { feed, sim, out: publish(feed, sim, now, initial.stress) }
}

export function LiveDemo({ initial, boot, onTheme }: { initial: LiveOptions; boot: LiveBoot; onTheme?: (theme: LiveTheme) => void }) {
  const [theme, setTheme] = useState<LiveTheme>(initial.theme)
  const [tab, setTab] = useState<LiveTab>(initial.tab)
  const feed = useRef<FeedState>(boot.feed)
  const [sim, setSim] = useState<SimState>(boot.sim)
  const [out, setOut] = useState<Published>(boot.out)
  const [ticks, setTicks] = useState(0)
  // the cards' records and output, from the simulator as it stands when they are asked
  const simRef = useRef(sim)
  simRef.current = sim
  const dataSource = useMemo<CardDataSource>(() => createLiveDataSource(() => simRef.current), [])

  useEffect(() => {
    const timer = window.setInterval(() => setSim((s) => advance(s, Date.now())), TICK_MS)
    return () => window.clearInterval(timer)
  }, [])
  // each tick that moved the run: the harness's word, published
  const published = useRef(sim)
  useEffect(() => {
    if (published.current === sim) return
    published.current = sim
    setOut(publish(feed.current, sim, Date.now(), initial.stress))
    setTicks((n) => n + 1)
  }, [sim, initial.stress])

  useLayoutEffect(() => {
    document.documentElement.dataset.liveTheme = theme
    onTheme?.(theme)
  }, [theme, onTheme])

  const collab = useStore((s) => s.collab)
  const agents = useAgents()
  const board = useMemo(() => (collab.graph ? scopeToAgents(collab.graph) : null), [collab.graph])
  const byKey = useMemo(() => new Map(agents.map((a) => [a.participant_alias ?? a.id, a])), [agents])
  const sched = scheduleAt(sim.step)
  const counts = useMemo(() => {
    const c = { running: 0, queued: 0, done: 0 }
    for (const a of agents) { if (a.status === 'running') c.running++; else if (a.status === 'queued') c.queued++; else c.done++ }
    return c
  }, [agents])
  const clock = Date.now()
  const metricsEntry = useMemo<ThreadEntry>(() => ({ kind: 'ui', runId: TRAINER_RUN, surface: out.metrics }), [out.metrics])
  const evalsEntry = useMemo<ThreadEntry>(() => ({ kind: 'ui', runId: TRAINER_RUN, surface: out.evals }), [out.evals])
  const reset = () => { feed.current.kept = new Map(); setSim({ ...createSim(Date.now(), initial.seed), speed: sim.speed, paused: sim.paused }) }
  const cardRows = ['trainer', 'evaluator', 'reporter'].map((k) => byKey.get(k)).filter((r): r is Lineage => !!r)

  return (
    <div className={`live-demo${theme === 'atelier' ? ' atelier' : ''}`} data-theme={theme} data-tab={tab} data-testid="live-demo" data-step={sim.step} data-tick={ticks}
         data-revision={out.metrics.revision} data-points={feed.current.points} data-spec-chars={feed.current.specChars} data-paused={sim.paused ? 'true' : 'false'} data-speed={sim.speed}>
      <header className="live-head">
        <h1 className="live-title">Training run <span>r14</span></h1>
        <p className="live-status" data-testid="live-status">
          <span className={`live-mode${sim.paused ? ' paused' : ''}`}><i aria-hidden="true" />{sim.paused ? 'Paused' : 'Live'}</span>
          <span className="live-sim" data-testid="live-simulated" title="Every number on this page is generated by the demo">Simulated</span>
          <span data-testid="live-step">Step <b>{thousands(sim.step)}</b> of {thousands(TOTAL_STEPS)}</span>
          <span>{sched.evalPhase === 'running' ? <>Eval ckpt {thousands(sched.k * CKPT_EVERY)} <b>{Math.round((sched.phaseStep / EVAL_STEPS) * 64)}/64</b></> : <>Next ckpt {thousands((sched.k + 1) * CKPT_EVERY)}</>}</span>
          <span data-testid="live-counts"><b>{counts.running}</b> running · <b>{counts.queued}</b> queued · <b>{counts.done}</b> done</span>
        </p>
        <span className="live-spacer" />
        <nav className="live-tabs" aria-label="View">
          <button type="button" aria-pressed={tab === 'run'} className={tab === 'run' ? 'on' : undefined} onClick={() => setTab('run')} data-testid="live-tab-run">Run</button>
          <button type="button" aria-pressed={tab === 'agents'} className={tab === 'agents' ? 'on' : undefined} onClick={() => setTab('agents')} data-testid="live-tab-agents">Agents <span>{agents.length}</span></button>
        </nav>
        <div className="live-controls">
          <button type="button" className="live-btn" onClick={() => setSim((s) => ({ ...s, paused: !s.paused }))} aria-pressed={sim.paused} data-testid="live-pause" title={sim.paused ? 'Resume' : 'Pause'}>
            {sim.paused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}<span>{sim.paused ? 'Resume' : 'Pause'}</span>
          </button>
          <Seg<Speed> value={sim.speed} label="Speed" testId="live-speed" options={[{ value: 1, label: '1×' }, { value: 4, label: '4×' }]} onChange={(speed) => setSim((s) => ({ ...s, speed }))} />
          <button type="button" className="live-btn" onClick={reset} data-testid="live-reset" title="Back to the start"><RotateCcwIcon size={12} /><span>Reset</span></button>
          <Seg<LiveTheme> value={theme} label="Skin" testId="live-theme" options={[{ value: 'atelier', label: 'Atelier' }, { value: 'signal', label: 'Signal' }]} onChange={setTheme} />
        </div>
      </header>

      {tab === 'run' ? (
        <main className="live-run">
          <section className="live-metrics" aria-label="Training metrics"><UiSurfaceBlock entry={metricsEntry} /></section>
          <aside className="live-side">
            <section className="live-panel live-outline" aria-label="Agent Teams">
              <h2 className="live-label">Agent Teams</h2>
              <div className="live-outline-body"><AgentOutline /></div>
            </section>
            <section className="live-panel live-evals" aria-label="Checkpoint evals"><UiSurfaceBlock entry={evalsEntry} /></section>
          </aside>
          <section className="live-cards" aria-label="Agents">
            {cardRows.map((row) => <AgentCard key={row.id} row={row} clock={clock} height={CARD_H} dataSource={dataSource} />)}
          </section>
          <section className="live-board" aria-label="Timeline">
            {board && <AgentsBoard graph={board} source="graph" />}
          </section>
        </main>
      ) : (
        <main className="live-agents">
          <aside className="live-agents-side">
            <section className="live-panel" aria-label="Agent Teams">
              <h2 className="live-label">Agent Teams</h2>
              <div className="live-outline-body tall"><AgentOutline /></div>
            </section>
          </aside>
          <DeskHost dataSource={dataSource} />
        </main>
      )}
    </div>
  )
}
