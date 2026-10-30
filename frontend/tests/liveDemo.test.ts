/** The live UI demo (src/demo): the simulator's shapes and determinism, every fixture in the contract's shapes and
 *  bounds, revisions that only go up, and the isolation — while the demo runs, the stores' actions reach neither the
 *  harness (no fetch) nor the browser's storage, and both stores are put back whole afterwards. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { CollaborationGraphSchema, DiffResponseSchema, OutputWindowSchema, parseUiSurfaceSpec, RunDetailResponseSchema, RunSchema, RunTreeRowSchema, UI_LIMITS, uiChartPointCount } from '@oasis-code/contract'
import {
  advance, bucketed, CKPT_EVERY, createSim, EVAL_STEPS, evalsDone, lossTrend, SAVE_EVERY, scheduleAt, spikeOf, START_STEP, stepMetrics, type SimState,
} from '../src/demo/liveSim.ts'
import { createLiveDataSource } from '../src/demo/liveDataSource.ts'
import { demoGraph, demoRuns, evalsSpec, metricsSpec, runRecord, SERIES_CAP, streamOf, treeRow } from '../src/demo/liveFixtures.ts'

// the stores are bundled by Vite; resolve their extensionless imports for Node (as tests/store-routing.test.ts does)
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(candidate)) return next(candidate.href, context)
  }
  return next(specifier, context)
} })

// a storage the page would have, with the person's own keys in it: the demo must leave every key and value as it was
class SentinelStorage {
  data = new Map<string, string>([['oasis-code.stackMode', 'grid'], ['oasis-code.desk.s_real', '{"windows":{}}'], ['oasis-code.token', 'tok-sentinel'], ['other.app', 'x']])
  writes: string[] = []
  get length() { return this.data.size }
  key(i: number) { return [...this.data.keys()][i] ?? null }
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.writes.push(k); this.data.set(k, String(v)) }
  removeItem(k: string) { this.writes.push(k); this.data.delete(k) }
  clear() { this.writes.push('*'); this.data.clear() }
}
const storage = new SentinelStorage()
const before = JSON.stringify([...storage.data])
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
const fetched: string[] = []
globalThis.fetch = (async (input: unknown) => { fetched.push(String(input)); throw new Error('no network in this test') }) as typeof fetch

const walk = (from: number, ticks: number, speed: 1 | 4 = 1): SimState => {
  let sim: SimState = { ...createSim(1_000_000, 14, from), speed }
  for (let i = 0; i < ticks; i++) sim = advance(sim, 1_000_000 + (i + 1) * 500)
  return sim
}

test('the simulator: a value is a function of (seed, step); another seed draws another run', () => {
  assert.deepEqual(stepMetrics(14, 3_210), stepMetrics(14, 3_210))
  assert.notDeepEqual(stepMetrics(14, 3_210), stepMetrics(15, 3_210))
  // a sliding window never re-buckets what it drew: the points both windows hold are the same
  const a = bucketed(3_000, 1_500, 8, (m) => m.trainLoss, 'mean', 14)
  const b = bucketed(3_040, 1_500, 8, (m) => m.trainLoss, 'mean', 14)
  const bx = new Map(b.map((p) => [p.x, p.value]))
  const shared = a.filter((p) => bx.has(p.x) && p.x < 3_000 - 8)
  assert.ok(shared.length > 100)
  for (const p of shared) assert.equal(bx.get(p.x), p.value)
})

test('the shapes: the loss falls with noise and a spike, the grad norm is clipped, a save is a gap, val lands late', () => {
  const mean = (lo: number, hi: number) => { let s = 0; for (let i = lo; i < hi; i++) s += stepMetrics(14, i).trainLoss; return s / (hi - lo) }
  assert.ok(mean(0, 200) > mean(2_000, 2_200) + 0.5 && mean(2_000, 2_200) > mean(6_000, 6_200))
  // not a rule: neighbouring steps differ, and around the trend by a few hundredths
  const diffs = Array.from({ length: 200 }, (_, i) => Math.abs(stepMetrics(14, 4_000 + i + 1).trainLoss - stepMetrics(14, 4_000 + i).trainLoss))
  assert.ok(diffs.filter((d) => d > 0.002).length > 150)
  const { at, amp } = spikeOf(14, 4_600)
  assert.ok(stepMetrics(14, at).trainLoss - lossTrend(at) > amp * 0.6, 'the spike shows')
  assert.ok(stepMetrics(14, at).gradNorm > stepMetrics(14, at - 40).gradNorm * 2)
  for (let s = 0; s < 6_000; s++) assert.ok(stepMetrics(14, s).gradNorm <= 5)
  assert.equal(stepMetrics(14, 2 * SAVE_EVERY + 3).tokPerSec, null)
  assert.ok(stepMetrics(14, 2 * SAVE_EVERY + 40).tokPerSec! > 30)
  assert.ok(!evalsDone(9 * CKPT_EVERY + EVAL_STEPS - 1).includes(9) && evalsDone(9 * CKPT_EVERY + EVAL_STEPS).includes(9))
})

test('the trainer\'s card shows the tool at work: a running bash call it follows the log with, not a thought', () => {
  const sim = walk(START_STEP, 7)
  const trainer = demoRuns(sim).find((r) => r.agent.key === 'trainer')!
  const rows = streamOf(trainer)
  const last = rows.at(-1)!
  assert.equal(last.kind, 'activity'); assert.equal(last.tool, 'bash'); assert.equal(last.running, true)
  assert.match(String(last.args?.command), /tail -n 1 -f runs\/r14\/train\.log/)
  assert.equal(rows.filter((e) => e.kind === 'activity' && e.running).length, 1, 'one tool at work')
  assert.ok(rows.some((e) => e.kind === 'activity' && e.tool === 'bash' && !e.running && /torchrun/.test(String(e.args?.command))), 'the launch ran')
  // the evaluator under way: its eval command runs
  const ev = demoRuns(sim).find((r) => r.agent.key === 'evaluator' && r.status === 'running')!
  assert.ok(streamOf(ev).some((e) => e.kind === 'activity' && e.tool === 'bash' && e.running))
})

test('the schedule: the first frame has a run, a queued step and finished work; the phases turn over', () => {
  const runs = demoRuns(createSim(1_000_000))
  const latest = new Map(runs.map((r) => [r.agent.key, r.status]))
  assert.deepEqual([...latest.entries()].sort(), [['evaluator', 'running'], ['report', 'queued'], ['sweep', 'done'], ['trainer', 'running']])
  assert.equal(scheduleAt(START_STEP).evalPhase, 'running')
  const phases = new Set<string>()
  for (let t = 0; t < 70; t++) { const s = walk(START_STEP, t); phases.add(`${scheduleAt(s.step).evalPhase}/${scheduleAt(s.step).reportPhase}`) }
  assert.deepEqual([...phases].sort(), ['done/done', 'done/running', 'running/queued'])
})

test('every fixture parses with the contract, at every phase, 1x and 4x', () => {
  for (const sim of [createSim(1_000_000), walk(START_STEP, 25), walk(START_STEP, 40), walk(START_STEP, 52), walk(START_STEP, 80, 4), walk(980, 12)]) {
    const runs = demoRuns(sim)
    for (const r of runs) {
      RunTreeRowSchema.parse(treeRow(r))
      RunSchema.parse(runRecord(r))
      assert.ok(streamOf(r).length > 0)
    }
    CollaborationGraphSchema.parse(demoGraph(runs, 3))
    const view = metricsSpec(sim)
    const parsed = parseUiSurfaceSpec(view.spec)
    assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.errors))
    assert.ok(parseUiSurfaceSpec(evalsSpec(sim)).ok)
    for (const el of Object.values(view.spec.elements ?? {})) if (el.type === 'chart') assert.ok(uiChartPointCount(el.props) <= UI_LIMITS.chartPoints)
  }
})

test('the cards\' data source answers records, output and an empty diff in memory, in the contract\'s shapes', async () => {
  let sim = walk(START_STEP, 10)
  const source = createLiveDataSource(() => sim)
  const detail = RunDetailResponseSchema.parse(await source.run('run_trainer01'))
  assert.equal(detail.executions.length, 1)
  const first = OutputWindowSchema.parse(await source.output(detail.executions[0]!.id, 'stdout', 0, 65536))
  assert.equal(detail.executions[0]!.status, 'running')
  assert.match(detail.executions[0]!.command, /tail -n 1 -f/)
  assert.ok(first.running && first.text.includes(`step ${String(Math.floor(sim.step / 10) * 10).padStart(5)}`))
  sim = walk(START_STEP, 20)
  const later = await source.output(detail.executions[0]!.id, 'stdout', 0, 65536)
  assert.notEqual(later.text, first.text, 'the log moves with the run')
  const done = RunDetailResponseSchema.parse(await source.run('run_eval020'))
  assert.equal(done.executions[0]!.status, 'succeeded')
  DiffResponseSchema.parse(await source.diff('w'))
  await assert.rejects(source.run('run_unknown'))
  assert.deepEqual(fetched, [])
})

test('the point bounds: within this build\'s bound, a larger bound (up to 400 a series) and stress, the spec stays under its size', () => {
  const sim = walk(5_000, 10)
  const here = metricsSpec(sim)
  assert.ok(JSON.stringify(here.spec).length < UI_LIMITS.specChars)
  // a bound of 2,048 points a chart: the dense series stop at the cap; the spec still fits
  const wide = metricsSpec(sim, { limit: 2_048, cap: SERIES_CAP })
  const charts = Object.values(wide.spec.elements ?? {}).filter((e) => e.type === 'chart')
  for (const c of charts) assert.ok(c.type === 'chart' && uiChartPointCount(c.props) <= 2_048)
  assert.ok(Math.max(...Object.values(wide.perChart)) <= SERIES_CAP + 12)
  // a narrower bound (the contract's earlier 100) thins every chart to it
  const narrow = metricsSpec(sim, { limit: 100, cap: SERIES_CAP })
  for (const c of Object.values(narrow.spec.elements ?? {})) if (c.type === 'chart') assert.ok(uiChartPointCount(c.props) <= 100)
  assert.ok(wide.points > narrow.points * 3, `${wide.points} vs ${narrow.points}`)
  assert.equal(UI_LIMITS.chartPoints, 2_048)
  assert.deepEqual(here.perChart, wide.perChart, 'this build draws within its own bound, up to the cap')
  assert.ok(JSON.stringify(wide.spec).length < UI_LIMITS.specChars)
  const stress = metricsSpec(sim, { limit: 2_048, cap: SERIES_CAP, stress: true })
  assert.ok(stress.perChart.loss! > 1_500 && stress.perChart.loss! <= 2_048, String(stress.perChart.loss))
  assert.ok(JSON.stringify(stress.spec).length < UI_LIMITS.specChars)
})

test('the feed: each moving tick is a new revision, later in time; a still spec is not republished; nothing is fetched or stored', async () => {
  const { useStore } = await import('../src/state/store.ts')
  const { useDesk } = await import('../src/state/desk.ts')
  const { installLiveAdapter, adapterCalls } = await import('../src/demo/liveAdapter.ts')
  const { createFeed, openDemoSession, publish } = await import('../src/demo/liveFeed.ts')
  const pageBefore = useStore.getState()
  const deskBefore = useDesk.getState()
  const restore = installLiveAdapter()
  try {
    openDemoSession()
    const feed = createFeed()
    let sim = createSim(2_000_000)
    let last = publish(feed, sim, 2_000_000)
    assert.equal(last.metrics.revision, 1)
    for (let i = 1; i <= 30; i++) {
      sim = advance(sim, 2_000_000 + i * 500)
      const next = publish(feed, sim, 2_000_000 + i * 500)
      assert.equal(next.metrics.revision, last.metrics.revision + 1)
      assert.ok(next.metrics.updated_at > last.metrics.updated_at)
      assert.ok(next.evals.revision >= last.evals.revision)
      last = next
    }
    // paused: the same spec, no new revision
    const again = publish(feed, { ...sim, paused: true }, 2_000_000 + 99_000)
    assert.equal(again.metrics.revision, last.metrics.revision)
    const s = useStore.getState()
    assert.equal(s.session?.id, 'demo_live_ui')
    assert.ok(s.tree.length >= 10 && s.runs.length === s.tree.length)
    assert.equal(s.collab.graph?.participants.length, 4)
    // what the components may ask of the stores: answered in memory
    await s.cancelRun('run_trainer01'); await s.watchChild('run_eval020'); await s.loadTree(); await s.syncSession(); await s.loadSurfaces()
    s.startSync()()
    const d = useDesk.getState()
    d.ensure('run:run_trainer01', 'run', 'run_trainer01'); d.ensure('run:run_eval020', 'run', 'run_eval020')
    d.focus('run:run_trainer01'); d.setMin('run:run_eval020', true); d.expand('run:run_eval020'); d.reveal('run:run_trainer01', 'run_trainer01')
    d.setStackMode('cascade'); d.setStackCorner('bl'); d.setCardSize({ w: 500, h: 300 }); d.forget('run:run_eval020'); d.openSession('demo_other')
    assert.ok(adapterCalls().some((c) => c.action === 'cancelRun') && adapterCalls().some((c) => c.action === 'setStackMode'))
  } finally {
    restore()
  }
  assert.deepEqual(fetched, [], 'nothing fetched')
  assert.deepEqual(storage.writes, [], 'nothing written to the storage')
  assert.equal(JSON.stringify([...storage.data]), before)
  // both stores whole again: their state and their own actions
  assert.equal(useStore.getState().cancelRun, pageBefore.cancelRun)
  assert.equal(useStore.getState().session, pageBefore.session)
  assert.equal(useStore.getState().tree, pageBefore.tree)
  assert.equal(useDesk.getState().focus, deskBefore.focus)
  assert.equal(useDesk.getState().windows, deskBefore.windows)
  assert.equal(useDesk.getState().stackMode, deskBefore.stackMode)
})
