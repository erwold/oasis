/** The live UI demo's feed: each tick of the simulator, what the harness would have said by now — the run rows, the
 *  collaboration graph, each run's stream and the surfaces' new revisions — put into the page's store for the
 *  product's components to read. Only the demo calls it, with the adapter installed (liveAdapter.ts). */

import { UI_LIMITS, type RunTreeRow, type UiSurfaceSpec } from '@oasis-code/contract'
import type { ModelEntry, Run, SessionDetail } from '../api/types'
import { useStore } from '../state/store'
import { useDesk } from '../state/desk'
import type { ThreadEntry } from '../state/thread'
import type { UiSurfaceRecord } from '../state/uiSurface'
import { claimSurfaces } from './liveAdapter'
import {
  AGENTS_FROM, DEMO_MODEL, DEMO_PROJECT, DEMO_SESSION, evalRunId, reportRunId, demoGraph, demoRuns, evalsSpec, metricsSpec, SERIES_CAP, runRecord, streamOf, surfaceRecord, surfaceWriter, TRAINER_RUN, treeRow,
  type ChartBudget,
} from './liveFixtures'
import type { SimState } from './liveSim'

export const SURFACE_IDS = ['training_metrics', 'checkpoint_evals'] as const
/** each agent's card (its first run's): the desk's window ids */
export const DEMO_CARDS = ['run:run_trainer01', `run:${evalRunId(AGENTS_FROM)}`, `run:${reportRunId(AGENTS_FROM)}`, 'run:run_sweep01']

export interface FeedState {
  /** each surface's revision and the spec it last published (a revision only when the spec changed) */
  revisions: Record<string, { revision: number; json: string; createdAt: number; record: UiSurfaceRecord | null }>
  graphRevision: number
  /** the points the metrics surface draws now, in all and per chart */
  points: number
  perChart: Record<string, number>
  specChars: number
  /** what each run's row and stream were last tick: kept as the same objects while they did not change, so a card or
   *  a row whose run did not move draws nothing again */
  kept: Map<string, { key: string; row: RunTreeRow; rows: ThreadEntry[]; record: Run }>
}

export function createFeed(): FeedState {
  return { revisions: {}, graphRevision: 0, points: 0, perChart: {}, specChars: 0, kept: new Map() }
}

/** the one model route the demo's runs name, as the models list would say it (its label on the cards) */
const MODEL: ModelEntry = {
  id: DEMO_MODEL, label: 'Opus 5.5', provider: 'anthropic', configured_model: 'claude-opus-5-5', endpoint: 'simulated', api: 'simulated', auth: 'api_key',
  account: 'demo', account_label: null, credential: 'unavailable', credential_source: null, credential_hint: null, credential_env: null,
  context_window: 200_000, window_source: 'simulated', concurrency: null, slot_scope: 'simulated', capabilities: {}, capability_source: 'simulated',
  pricing: null, cost_basis: 'simulated', default: true,
}

const SESSION = {
  id: DEMO_SESSION, project_id: DEMO_PROJECT, model: DEMO_MODEL, title: 'r14 · 1.3B SFT', workspace: null, runs: [], director: null,
  interactions: [], relays: [], director_notes: [],
} as unknown as SessionDetail

/** Open the demo's session in the stores: the desk's cards for it, its surfaces' queues claimed (before any draws). */
export function openDemoSession(): void {
  claimSurfaces(SURFACE_IDS.map((surface_id) => ({ session_id: DEMO_SESSION, run_id: TRAINER_RUN, surface_id })))
  useDesk.getState().openSession(DEMO_SESSION)
  // the whole desk at once: every card tiled (in memory, as every desk move of the demo)
  useDesk.getState().setStackMode('grid')
  // the four agents' cards are on the desk from the start, none put away on the shelf as the desk opens
  const at = Date.now()
  useDesk.setState({ revealed: Object.fromEntries(DEMO_CARDS.map((id) => [id, at])) })
  useStore.setState({ session: SESSION, models: [MODEL], runs: [], notes: [], interactions: [], relays: [], director: null, replaying: false, treeOf: DEMO_SESSION })
}

/** The chart's bound: the contract's (this build's) — `stress` asks for every point it allows in one chart. */
export function budgetOf(stress: boolean): ChartBudget {
  return { limit: UI_LIMITS.chartPoints, cap: SERIES_CAP, stress }
}

function publishSurface(feed: FeedState, spec: UiSurfaceSpec, writer: string, now: number): UiSurfaceRecord {
  const json = JSON.stringify(spec)
  const had = feed.revisions[spec.surface_id]
  if (had && had.json === json && had.record) return had.record
  const revision = (had?.revision ?? 0) + 1
  const createdAt = had?.createdAt ?? now
  // updated_at strictly increases at every write of a row
  const at = had?.record ? Math.max(now, Date.parse(had.record.updated_at) + 1) : now
  const record = surfaceRecord(spec, revision, writer, createdAt, at)
  feed.revisions[spec.surface_id] = { revision, json, createdAt, record }
  return record
}

export interface Published { metrics: UiSurfaceRecord; evals: UiSurfaceRecord }

/** One tick's word: the stores updated, the surfaces' records (a new revision where the spec changed). */
export function publish(feed: FeedState, sim: SimState, now: number, stress = false): Published {
  const runs = demoRuns(sim)
  const tree: RunTreeRow[] = []
  const childThreads: Record<string, ThreadEntry[]> = {}
  const records: Run[] = []
  const kept = new Map<string, { key: string; row: RunTreeRow; rows: ThreadEntry[]; record: Run }>()
  for (const r of runs) {
    const row = treeRow(r)
    const key = JSON.stringify([row, r.events])
    const had = feed.kept.get(r.id)
    const entry = had && had.key === key ? had : { key, row, rows: streamOf(r), record: runRecord(r) }
    kept.set(r.id, entry)
    tree.push(entry.row)
    records.push(entry.record)
    childThreads[r.id] = entry.rows
  }
  feed.kept = kept
  feed.graphRevision += 1
  const graph = demoGraph(runs, feed.graphRevision)
  useStore.setState({
    tree, childThreads, runs: records,
    collab: { sessionId: DEMO_SESSION, status: 'graph', graph, revision: graph.revision, error: null, told: false },
  })
  const view = metricsSpec(sim, budgetOf(stress))
  feed.points = view.points
  feed.perChart = view.perChart
  feed.specChars = JSON.stringify(view.spec).length
  const writer = surfaceWriter(sim)
  return { metrics: publishSurface(feed, view.spec, writer, now), evals: publishSurface(feed, evalsSpec(sim), writer, now) }
}
