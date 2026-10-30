import { endingOf } from '../state/outline.ts'

/** How an agent is shown wherever it appears — the timeline's lanes, the Agent Teams outline, the desk's cards: the
 *  short word for where it stands, its tone, the elapsed clock, what it is doing now and how often the timeline's
 *  live edge is redrawn. Pure: read from the rows the page already holds, nothing estimated. */

/** The tone a state is drawn in: live (at work), wait (queued, its turn not come), ok, bad (failed), mute (stopped). */
export type AgentTone = 'live' | 'wait' | 'ok' | 'bad' | 'mute'

const SHORT: Record<string, string> = { running: 'running', queued: 'queued', waiting: 'waiting', done: 'done', error: 'failed', cancelled: 'stopped', interrupted: 'interrupted' }
const TONE: Record<string, AgentTone> = { running: 'live', queued: 'wait', waiting: 'wait', done: 'ok', error: 'bad', cancelled: 'mute', interrupted: 'bad' }

/** A run's status as one short word (an unknown status is said as it is). */
export const stateWord = (status: string): string => SHORT[status] ?? status
export const stateTone = (status: string): AgentTone => TONE[status] ?? 'mute'

/** Where an agent's latest run stands on its lane: queued or waiting as it is (live or not — its turn has not come);
 *  else a live run runs, whatever an older status said; else its status. */
export function laneStatus(status: string, live: boolean): string {
  if (status === 'queued' || status === 'waiting') return status
  return live ? 'running' : status
}

/** An agent's short state word where it already has one (a desk card's meta, a card's conversation head, a lane):
 *  the same reading its bot plays (state/presence.ts). A live run says what its bot does — working, thinking, waiting
 *  (a slot, its folder), "needs you" (a form it waits on) — and a queued one says queued, never "idle"; an ended one
 *  says its status, unless what waits for its agent now is said instead: a watch ("waiting"), an approval or a
 *  proposal ("needs you"). */
export function cardStateWord(run: { status: string; receipt?: unknown }, state: string): string {
  if (run.status === 'queued') return 'queued'
  if (run.status === 'running') return state === 'blocked' ? 'needs you' : state === 'idle' || state === 'static' || state === 'done' ? 'running' : state
  if (state === 'waiting') return 'waiting'
  if (state === 'blocked' && endingOf(run) !== 'blocked') return 'needs you'
  return run.status
}

/** Elapsed time, compact and steady in width: 42s, 3m 05s, 1h 12m. */
export function elapsedText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** How often the timeline lays itself out again while a run works: as soon as the live bar has grown a pixel (the
 *  board's scale, px a minute), never more than once a second nor less than every 15 s. */
export function liveTickMs(pxPerMin: number): number {
  if (!Number.isFinite(pxPerMin) || pxPerMin <= 0) return 15_000
  return Math.round(Math.min(15_000, Math.max(1_000, 60_000 / pxPerMin)) / 250) * 250
}

interface EntryLike { kind: string; tool?: string; summary?: string; running?: boolean }

/** What a run is doing now, from its own rows: the tool call still open (its tool and its summary), else null. */
export function workOf(entries: readonly EntryLike[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!
    if (e.kind === 'activity') {
      if (!e.running) return null
      const what = [e.tool, e.summary?.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' · ')
      return what ? (what.length > 96 ? `${what.slice(0, 95)}…` : what) : null
    }
    if (e.kind === 'agent' || e.kind === 'thinking') return null
  }
  return null
}

/** The first line of a run's latest answer in its rows (what it handed back), else null. */
export function answerHead(entries: readonly (EntryLike & { text?: string })[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!
    if (e.kind !== 'agent' || !e.text) continue
    const line = e.text.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean)
    if (line) return line.length > 120 ? `${line.slice(0, 119)}…` : line
  }
  return null
}

/** The tool calls a run's rows say ended. */
export function toolsDone(entries: readonly EntryLike[]): number {
  let n = 0
  for (const e of entries) if (e.kind === 'activity' && !e.running) n += 1
  return n
}

/** The lane of the timeline that holds the front card's agent: the first bar whose run is one of its runs. */
export function frontLaneOf(bars: readonly { lane: string; run: { id: string } }[], runs: ReadonlySet<string>): string | null {
  if (!runs.size) return null
  for (const b of bars) if (runs.has(b.run.id)) return b.lane
  return null
}

interface RunLike { id: string; parent_run_id: string | null; model: string | null; spawned_by: string }

/** How many agents each card's agent started: over every run of its lineage (a later run's children too), each child
 *  counted once by the agent it is (its card: a child run again or continued is one agent, not two); a person's
 *  action, a plan's own row or a run of the same agent is no agent it started. Keyed by the card's agent id. */
export function subAgentCounts(agents: readonly { id: string; lineage: readonly { id: string }[] }[], tree: readonly RunLike[]): Map<string, number> {
  const agentOfRun = new Map<string, string>()
  for (const a of agents) for (const r of a.lineage) agentOfRun.set(r.id, a.id)
  const started = new Map<string, Set<string>>()
  for (const r of tree) {
    if (!r.parent_run_id || !r.model || r.spawned_by === 'human_action' || r.spawned_by === 'plan') continue
    const parent = agentOfRun.get(r.parent_run_id)
    if (!parent) continue
    const child = agentOfRun.get(r.id) ?? r.id
    if (child === parent) continue
    const set = started.get(parent) ?? new Set<string>()
    set.add(child)
    started.set(parent, set)
  }
  return new Map([...started].map(([id, set]) => [id, set.size]))
}
