/** What the live UI demo feeds the product's own components, built from the simulator's state: the session's run rows
 *  (the outline's and the desk's), the collaboration graph (the agents' timeline), each run's stream as the thread
 *  reducer makes it from run events, and the intelligent-UI surfaces (a revision per tick). SIMULATED data in the
 *  contract's shapes — tests/liveDemo.test.ts parses every piece with the contract's schemas. Pure: no store, no DOM. */

import { UI_LIMITS, UI_SPEC_VERSION, type CollaborationGraph, type RunTreeRow, type UiSurfaceSpec } from '@oasis-code/contract'
import type { Run, SSEItem } from '../api/types.ts'
import { applyEvent, type ThreadEntry } from '../state/thread.ts'
import type { UiSurfaceRecord } from '../state/uiSurface.ts'
import {
  bucketed, CKPT_EVERY, CLIP, EVAL_STEPS, evalOf, evalsDone, REPORT_STEPS, round, scheduleAt, stepMetrics, timeOfStep, TOTAL_STEPS,
  type Phase, type SimState,
} from './liveSim.ts'

export const DEMO_SESSION = 'demo_live_ui'
export const DEMO_MODEL = 'anthropic:claude-opus-5-5'
export const DEMO_PROJECT = 'demo_live_project'
/** the chart's history: the last steps drawn (older steps leave the window; the table keeps every checkpoint) */
export const WINDOW_STEPS = 1_500
/** at most this many points per series, whatever the bound (a dense line reads no better past it) */
export const SERIES_CAP = 400

const iso = (ms: number) => new Date(Math.round(ms)).toISOString()
const fmt = (v: number, d = 3) => v.toFixed(d)
const thousands = (n: number) => n.toLocaleString('en-US')

// ---- the agents ------------------------------------------------------------------------------------------------------

export interface Agent { key: 'trainer' | 'evaluator' | 'sweep' | 'report'; label: string; participant: string; conversation: string; index: number }

export const AGENTS: Agent[] = [
  { key: 'trainer', label: 'trainer', participant: 'pa_0000000000000a01', conversation: 'cv_0000000000000a01', index: 0 },
  { key: 'evaluator', label: 'evaluator', participant: 'pa_0000000000000a02', conversation: 'cv_0000000000000a02', index: 1 },
  { key: 'sweep', label: 'lr-sweep', participant: 'pa_0000000000000a03', conversation: 'cv_0000000000000a03', index: 2 },
  { key: 'report', label: 'reporter', participant: 'pa_0000000000000a04', conversation: 'cv_0000000000000a04', index: 3 },
]
const agentOf = (key: Agent['key']) => AGENTS.find((a) => a.key === key)!

export const TRAINER_RUN = 'run_trainer01'
/** the checkpoint the evaluator and the reporter took over from (their first runs) */
export const AGENTS_FROM = 20
export const evalRunId = (k: number) => `run_eval${String(k).padStart(3, '0')}`
export const reportRunId = (k: number) => `run_report${String(k).padStart(3, '0')}`
const SWEEP_RUNS = ['run_sweep01', 'run_sweep02', 'run_sweep03']

/** One run of the demo, before it is a tree row, a graph run and a stream. */
export interface DemoRun {
  id: string
  agent: Agent
  status: Phase
  createdAt: number
  finishedAt: number | null
  userText: string
  resumes: string | null
  dependsOn: string[]
  seq: number
  events: Omit<SSEItem, 'id'>[]
  finalChars: number | null
}

const ev = (event: string, data: Record<string, unknown>): Omit<SSEItem, 'id'> => ({ event, data })

function trainerRun(sim: SimState): DemoRun {
  const s = sim.step
  // the trainer launched the job in the background, reads each checkpoint as it lands, and follows the job's log: the
  // follow is its tool at work now (running, no result yet) — the card says what runs, not a made-up thought
  const events: Omit<SSEItem, 'id'>[] = [
    ev('run_started', { model: DEMO_MODEL }),
    ev('tool_call', { tool_call_id: 'tc_launch', tool: 'bash', command: 'nohup torchrun --nproc_per_node 8 train.py --config configs/sft-1p3b.yaml --lr 3e-4 > runs/r14/train.log 2>&1 &' }),
    ev('tool_result', { tool_call_id: 'tc_launch', tool: 'bash', status: 'ok', exit_code: 0, duration_ms: 1_180 }),
  ]
  const k = Math.floor(s / CKPT_EVERY)
  for (let c = Math.max(1, k - 3); c <= k; c++) {
    const at = c * CKPT_EVERY
    const cm = stepMetrics(sim.seed, at)
    events.push(ev('tool_call', { tool_call_id: `tc_ck${c}`, tool: 'read_file', path: `runs/r14/ckpt/step_${String(at).padStart(5, '0')}/metrics.json` }))
    events.push(ev('tool_result', { tool_call_id: `tc_ck${c}`, tool: 'read_file', status: 'ok', lines: 48 }))
    events.push(ev('text_block', { text: `Checkpoint ${thousands(at)} saved · train ${fmt(cm.trainLoss)} · ${cm.tokPerSec === null ? 'writing' : `${cm.tokPerSec.toFixed(1)}k tok/s`} · eval handed to evaluator.` }))
  }
  events.push(ev('tool_call', { tool_call_id: `tc_follow${k}`, tool: 'bash', command: 'tail -n 1 -f runs/r14/train.log' }))
  return {
    id: TRAINER_RUN, agent: agentOf('trainer'), status: 'running', createdAt: timeOfStep(sim, 0), finishedAt: null,
    userText: 'Fine-tune the 1.3B model on the r14 mix with the swept learning rate; checkpoint every 250 steps and hand each checkpoint to the evaluator.',
    resumes: null, dependsOn: [], seq: 1, events, finalChars: null,
  }
}

function evalRun(sim: SimState, k: number, current: boolean): DemoRun {
  const sched = scheduleAt(sim.step)
  const running = current && sched.evalPhase === 'running'
  const at = k * CKPT_EVERY
  const r = evalOf(sim.seed, k)
  const ckpt = `ckpt/step_${String(at).padStart(5, '0')}`
  const events: Omit<SSEItem, 'id'>[] = [
    ev('run_started', { model: DEMO_MODEL, resumes_run_id: k > AGENTS_FROM ? evalRunId(k - 1) : null }),
    ev('tool_call', { tool_call_id: `tc_eval${k}`, tool: 'bash', command: `python eval.py --ckpt ${ckpt} --suite heldout-4k --batch 64` }),
  ]
  if (running) {
    const batch = Math.max(1, Math.round((sched.phaseStep / EVAL_STEPS) * 64))
    const partial = r.valLoss + 0.05 * (1 - batch / 64)
    events.push(ev('text_delta', { start: true, text: `batch ${batch}/64 · running val loss ${fmt(partial)} · acc ${(r.acc * 100 - 2 * (1 - batch / 64)).toFixed(1)}%` }))
  } else {
    events.push(ev('tool_result', { tool_call_id: `tc_eval${k}`, tool: 'bash', status: 'ok', exit_code: 0, duration_ms: 14_400 + Math.round(r.acc * 1000) }))
    events.push(ev('text_block', { text: `Checkpoint ${thousands(at)}: val loss ${fmt(r.valLoss)} · accuracy ${(r.acc * 100).toFixed(1)}% · reward ${fmt(r.reward, 2)}.` }))
    events.push(ev('run_finished', { status: 'done' }))
  }
  return {
    id: evalRunId(k), agent: agentOf('evaluator'), status: running ? 'running' : 'done',
    createdAt: timeOfStep(sim, at), finishedAt: running ? null : timeOfStep(sim, at + EVAL_STEPS),
    userText: `Evaluate ${ckpt} on heldout-4k and post the numbers.`, resumes: k > AGENTS_FROM ? evalRunId(k - 1) : null, dependsOn: [], seq: k,
    events, finalChars: running ? null : 74,
  }
}

function reportRun(sim: SimState, k: number, current: boolean): DemoRun {
  const sched = scheduleAt(sim.step)
  const status: Phase = current ? sched.reportPhase : 'done'
  const at = k * CKPT_EVERY
  const r = evalOf(sim.seed, k)
  const prev = k > 1 ? evalOf(sim.seed, k - 1) : null
  const events: Omit<SSEItem, 'id'>[] = []
  if (status === 'queued') events.push(ev('run_queued', { reason: `waiting for ${evalRunId(k)}` }))
  else {
    events.push(ev('run_started', { model: DEMO_MODEL }))
    events.push(ev('tool_call', { tool_call_id: `tc_rd${k}`, tool: 'read_file', path: `evals/ckpt_${String(at).padStart(5, '0')}.json` }))
    events.push(ev('tool_result', { tool_call_id: `tc_rd${k}`, tool: 'read_file', status: 'ok', lines: 212 }))
    const editing = status === 'running' && sched.phaseStep < EVAL_STEPS + REPORT_STEPS / 2
    events.push(ev('tool_call', { tool_call_id: `tc_ed${k}`, tool: 'edit_file', path: 'reports/r14.md' }))
    if (!editing) events.push(ev('tool_result', { tool_call_id: `tc_ed${k}`, tool: 'edit_file', status: 'ok', op: 'edit' }))
    const delta = prev ? r.valLoss - prev.valLoss : 0
    const words = `Ckpt ${thousands(at)}: val ${fmt(r.valLoss)} (${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(3)} vs previous), acc ${(r.acc * 100).toFixed(1)}%.${delta > 0 ? ' Val rose while train fell: watching for overfit.' : ''}`
    if (status === 'running') events.push(ev('text_delta', { start: true, text: words.slice(0, Math.max(12, Math.round(words.length * ((sched.phaseStep - EVAL_STEPS) / REPORT_STEPS)))) }))
    else { events.push(ev('text_block', { text: words })); events.push(ev('run_finished', { status: 'done' })) }
  }
  const startStep = at + EVAL_STEPS
  return {
    id: reportRunId(k), agent: agentOf('report'), status,
    createdAt: timeOfStep(sim, status === 'queued' ? at : startStep), finishedAt: status === 'done' ? timeOfStep(sim, startStep + REPORT_STEPS) : null,
    userText: `Summarise checkpoint ${thousands(at)} in reports/r14.md once its eval lands.`, resumes: k > AGENTS_FROM ? reportRunId(k - 1) : null,
    dependsOn: status === 'queued' ? [evalRunId(k)] : [], seq: k, events, finalChars: status === 'done' ? 120 : null,
  }
}

function sweepRuns(sim: SimState): DemoRun[] {
  const t0 = timeOfStep(sim, 0)
  const lrs = [['1e-4', '0.982'], ['3e-4', '0.941'], ['1e-3', 'diverged at 410']]
  return SWEEP_RUNS.map((id, i) => {
    // three proxy runs one after another, the last ending just before the full run starts
    const created = t0 - (6.6 - i * 2.1) * 60_000
    const finished = created + 1.9 * 60_000
    const [lr, result] = lrs[i]!
    return {
      id, agent: agentOf('sweep'), status: 'done' as Phase, createdAt: created, finishedAt: finished,
      userText: i === 0 ? 'Sweep the learning rate on a 600-step proxy and pick one for the full run.' : `Next: lr ${lr}.`,
      resumes: i > 0 ? SWEEP_RUNS[i - 1]! : null, dependsOn: [], seq: i + 1, finalChars: 160,
      events: [
        ev('run_started', { model: DEMO_MODEL }),
        ev('tool_call', { tool_call_id: `tc_sw${i}`, tool: 'bash', command: `python train.py --config configs/proxy-600.yaml --lr ${lr}` }),
        ev('tool_result', { tool_call_id: `tc_sw${i}`, tool: 'bash', status: 'ok', exit_code: i === 2 ? 1 : 0, duration_ms: 128_000 + i * 4_100 }),
        ev('text_block', { text: i === 2 ? 'lr 1e-3 diverged at step 410 (loss NaN). 3e-4 holds: proxy val 0.941, the best of three. Handing it to the trainer.' : `lr ${lr}: proxy val ${result}.` }),
        ev('run_finished', { status: 'done' }),
      ],
    }
  })
}

/** Every run of the demo at the simulator's state, oldest first. */
export function demoRuns(sim: SimState): DemoRun[] {
  const { k } = scheduleAt(sim.step)
  const runs: DemoRun[] = [...sweepRuns(sim), trainerRun(sim)]
  // every eval and report since the agents joined: an agent's card and outline row are its first run's, kept for the
  // run's life (the checkpoints before were evaluated in the trainer's own loop: the table lists them all)
  for (let c = Math.max(1, Math.min(AGENTS_FROM, k)); c <= k; c++) runs.push(evalRun(sim, c, c === k))
  for (let c = Math.max(1, Math.min(AGENTS_FROM, k)); c <= k; c++) runs.push(reportRun(sim, c, c === k))
  return runs.sort((a, b) => a.createdAt - b.createdAt)
}

/** A run as the session's runs list it (store.runs): its record whole, so a card's records read it from the page. */
export function runRecord(run: DemoRun): Run {
  const ended = run.status === 'done'
  const final = ended ? (streamOf(run).filter((e) => e.kind === 'agent').at(-1)?.text ?? '') : ''
  return {
    id: run.id, session_id: DEMO_SESSION, project_id: DEMO_PROJECT, workspace_id: null, parent_run_id: null, resumes_run_id: run.resumes,
    spawned_by: 'human', label: run.agent.label, model: DEMO_MODEL, model_config_snapshot: {}, user_text: run.userText, status: run.status,
    usage: { input_tokens: 18_000 + run.seq * 900, output_tokens: 1_200 + run.seq * 40, requests: 3 + (run.seq % 4) },
    budget: {}, error: null, created_at: iso(run.createdAt), finished_at: run.finishedAt === null ? null : iso(run.finishedAt), saved_seq: run.events.length,
    receipt: ended ? ({ final_text: final } as unknown as Run['receipt']) : {}, work_order: null, attachments: [], relay_id: null, relay_step: null,
    interaction_id: null, interaction_node: null, collab: collabOf(run),
  }
}

// ---- the run rows, the graph, the streams --------------------------------------------------------------------------

const origin = (actor: 'person' | 'director') => ({
  actor, request: 'separate' as const, client: null, director_session_id: null, director_turn_id: null, tool_call_id: null,
  interaction_id: null, relay_id: null, watch_id: null, ui_task_id: null, parent_run_id: null, basis: 'recorded' as const,
})

function collabOf(run: DemoRun) {
  return {
    participant_id: run.agent.participant, participant_role: 'separate' as const, conversation_id: run.agent.conversation, conversation_seq: run.seq,
    origin: origin('person'), placement: { surface: 'card' as const, group: null, anchor: null }, basis: 'recorded' as const,
  }
}

export function treeRow(run: DemoRun): RunTreeRow {
  return {
    id: run.id, session_id: DEMO_SESSION, parent_run_id: null, resumes_run_id: run.resumes, spawned_by: 'human', label: run.agent.label,
    model: DEMO_MODEL, status: run.status, live: run.status === 'running', created_at: iso(run.createdAt), finished_at: run.finishedAt === null ? null : iso(run.finishedAt),
    workspace_id: null, user_text: run.userText, user_text_head: run.userText.split('\n')[0]!, work_order: null, receipt: null, error: null,
    usage: {}, depth: 0, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, plan_node_id: null,
    participant_id: null, participant_alias: run.agent.label, participant_index: run.agent.index, participant_name: run.agent.label,
    depends_on: run.dependsOn, scheduled_by: null, kind: 'run', collab: collabOf(run),
  }
}

export function demoGraph(runs: DemoRun[], revision: number): CollaborationGraph {
  const latest = new Map<string, DemoRun>()
  for (const r of runs) latest.set(r.agent.participant, r)
  const participants = AGENTS.map((a) => {
    const mine = runs.filter((r) => r.agent === a)
    const last = latest.get(a.participant) ?? null
    return {
      id: a.participant, session_id: DEMO_SESSION, role: 'separate' as const, alias: null, label: a.label, model: DEMO_MODEL, group: null,
      introduced_by: origin('person'), current_conversation_id: a.conversation, latest_run_id: last?.id ?? null,
      state: (mine.some((r) => r.status === 'running') ? 'running' : mine.some((r) => r.status === 'queued') ? 'queued' : 'idle') as 'running' | 'queued' | 'idle',
      run_count: mine.length, basis: 'recorded' as const, created_at: iso(mine[0]?.createdAt ?? Date.now()),
    }
  })
  const conversations = AGENTS.map((a) => {
    const mine = runs.filter((r) => r.agent === a)
    return {
      id: a.conversation, session_id: DEMO_SESSION, participant_id: a.participant, forked_from_run_id: null, root_run_id: mine[0]?.id ?? null,
      head_run_id: mine.at(-1)?.id ?? null, run_ids: mine.map((r) => r.id), tool_surface: 'agent.v2', basis: 'recorded' as const, created_at: iso(mine[0]?.createdAt ?? Date.now()),
    }
  })
  const graphRuns = runs.map((r) => ({
    id: r.id, status: r.status, live: r.status === 'running', model: DEMO_MODEL, label: r.agent.label, created_at: iso(r.createdAt),
    finished_at: r.finishedAt === null ? null : iso(r.finishedAt), workspace_id: null, resumes_run_id: r.resumes, interaction_id: null,
    interaction_node: null, relay_id: null, relay_step: null, user_text_head: r.userText.split('\n')[0]!, final_text_chars: r.finalChars, error: null, collab: collabOf(r),
  }))
  const ids = new Set(runs.map((r) => r.id))
  const edges: CollaborationGraph['edges'] = []
  // the sweep's pick reached the trainer; each checkpoint was cited to its eval; each eval's answer handed to its report
  if (ids.has(SWEEP_RUNS[2]!)) {
    edges.push({ id: 'e_sweep', kind: 'received', from: { kind: 'run', id: SWEEP_RUNS[2]! }, to: { kind: 'run', id: TRAINER_RUN }, basis: 'recorded', created_at: graphRuns.find((r) => r.id === TRAINER_RUN)!.created_at,
      meta: { via: 'dispatch', packet: 'whole', answer_chars: 160, handed_chars: 160, node: null, content_delivered: true } })
  }
  for (const r of runs) {
    if (r.agent.key === 'evaluator') {
      edges.push({ id: `e_ck${r.seq}`, kind: 'cited', from: { kind: 'run', id: TRAINER_RUN }, to: { kind: 'run', id: r.id }, basis: 'recorded', created_at: iso(r.createdAt),
        meta: { by: 'person', director_turn_id: null, note: `checkpoint ${thousands(r.seq * CKPT_EVERY)}`, content_delivered: false } })
    }
    if (r.agent.key === 'report' && r.status !== 'queued' && ids.has(evalRunId(r.seq))) {
      edges.push({ id: `e_rp${r.seq}`, kind: 'received', from: { kind: 'run', id: evalRunId(r.seq) }, to: { kind: 'run', id: r.id }, basis: 'recorded', created_at: iso(r.createdAt),
        meta: { via: 'dispatch', packet: 'whole', answer_chars: 74, handed_chars: 74, node: null, content_delivered: true } })
    }
  }
  return {
    session_id: DEMO_SESSION, revision: `demo-${revision}`, main_participant_id: null, actors: [{ kind: 'person' }], participants, conversations,
    groups: [], runs: graphRuns, nodes: [], edges, thread_items: [], legacy: { projected_runs: 0, inferred_facts: 0, notes: [] },
  }
}

/** A run's stream as the page's own reducer makes it from its events. */
export function streamOf(run: DemoRun): ThreadEntry[] {
  return run.events.reduce<ThreadEntry[]>((rows, e, i) => applyEvent(rows, run.id, { ...e, id: `${run.id}:${i}` }), [])
}

// ---- the surfaces -----------------------------------------------------------------------------------------------------

export interface ChartBudget {
  /** the contract's bound on one chart's points (every series together) */
  limit: number
  /** at most this many points per dense series */
  cap: number
  /** stress: the loss chart draws every step it may (up to the bound), over a longer window */
  stress?: boolean
}

/** The stride that keeps a dense series within `per` points over `window` steps (buckets are aligned to absolute steps,
 *  so a window spans one bucket more than it holds whole). */
export function strideFor(window: number, per: number): number {
  return Math.max(1, Math.ceil((window + 1) / Math.max(2, per - 1)))
}

/** points a dense series may hold beside `sparse` points in one chart */
const perSeries = (budget: ChartBudget, sparse: number, cap = budget.cap) => Math.max(2, Math.min(cap, budget.limit - sparse))

export interface MetricsView { spec: UiSurfaceSpec; points: number; perChart: Record<string, number> }

const series = (id: string, label: string, data: { x: number; value: number | null }[], dashed = false) => ({ id, label, ...(dashed ? { line_style: 'dashed' as const } : {}), data })

/** The training metrics surface: per metric its name, its latest value and a line over the same window (aligned
 *  small multiples, one x axis: the step). Each chart keeps within the contract's point bound and the spec within its
 *  character bound: when the spec would pass it, the dense series are thinned until it fits. */
export function metricsSpec(sim: SimState, budget: ChartBudget = { limit: UI_LIMITS.chartPoints, cap: SERIES_CAP }): MetricsView {
  let cap = budget.cap
  for (;;) {
    const view = buildMetrics(sim, { ...budget, cap })
    if (JSON.stringify(view.spec).length <= UI_LIMITS.specChars * 0.96 || cap <= 16) return view
    cap = Math.floor(cap * 0.8)
  }
}

function buildMetrics(sim: SimState, budget: ChartBudget): MetricsView {
  const s = sim.step
  const seed = sim.seed
  const m = stepMetrics(seed, s)
  const lossWindow = budget.stress ? Math.min(s, Math.max(WINDOW_STEPS, budget.limit - 16)) : WINDOW_STEPS
  const evals = evalsDone(s).map((k) => evalOf(seed, k))
  const inWindow = (w: number) => evals.filter((e) => e.step >= Math.max(0, s - w))
  const lastEval = evals.at(-1) ?? null
  const prevEval = evals.at(-2) ?? null
  const valPts = inWindow(lossWindow).map((e) => ({ x: e.step, value: round(e.valLoss) }))
  const accPts = inWindow(WINDOW_STEPS).map((e) => ({ x: e.step, value: round(e.acc) }))
  const lossCap = budget.stress ? budget.limit : budget.cap
  const dense = Math.min(budget.cap, SERIES_CAP * 4)
  const train = bucketed(s, lossWindow, strideFor(lossWindow, perSeries(budget, valPts.length, lossCap)), (x) => x.trainLoss, 'mean', seed)
  const reward = bucketed(s, WINDOW_STEPS, strideFor(WINDOW_STEPS, perSeries(budget, accPts.length, dense)), (x) => x.reward, 'mean', seed)
  const tok = bucketed(s, WINDOW_STEPS, strideFor(WINDOW_STEPS, perSeries(budget, 0, dense)), (x) => x.tokPerSec, 'mean', seed)
  const grad = bucketed(s, WINDOW_STEPS, strideFor(WINDOW_STEPS, perSeries(budget, 0, dense)), (x) => x.gradNorm, 'max', seed)
  const recentTok = tok.slice(-12).filter((p) => p.value !== null).map((p) => p.value as number)
  const tokNow = m.tokPerSec ?? (recentTok.length ? recentTok.reduce((a, b) => a + b, 0) / recentTok.length : null)
  const valDelta = lastEval && prevEval ? lastEval.valLoss - prevEval.valLoss : null
  const elements: UiSurfaceSpec['elements'] = {
    root: { type: 'row', children: ['loss', 'quality', 'speed', 'grad'] },
    loss: { type: 'card', children: ['loss_m', 'loss_c'] },
    loss_m: { type: 'metric', props: { label: 'Loss · train / val', value: round(m.trainLoss), unit: lastEval ? `val ${fmt(lastEval.valLoss)}${valDelta === null ? '' : ` ${valDelta <= 0 ? '▼' : '▲'}${Math.abs(valDelta).toFixed(3)}`}` : 'val pending' } },
    loss_c: { type: 'chart', props: { kind: 'line', x_axis: 'number', series: [series('train', 'train', train), series('val', 'val · per ckpt', valPts, true)] } },
    quality: { type: 'card', children: ['quality_m', 'quality_c'] },
    quality_m: { type: 'metric', props: { label: 'Reward · accuracy', value: round(m.reward), unit: lastEval ? `acc ${(lastEval.acc * 100).toFixed(1)}%` : 'acc pending' } },
    quality_c: { type: 'chart', props: { kind: 'line', x_axis: 'number', series: [series('reward', 'reward', reward), series('acc', 'accuracy · per ckpt', accPts, true)] } },
    speed: { type: 'card', children: ['speed_m', 'speed_c'] },
    speed_m: { type: 'metric', props: { label: 'Throughput', value: tokNow === null ? '—' : round(tokNow), unit: m.tokPerSec === null ? 'k tok/s · writing ckpt' : 'k tok/s' } },
    speed_c: { type: 'chart', props: { kind: 'line', x_axis: 'number', series: [series('tok', 'k tok/s', tok)] } },
    grad: { type: 'card', children: ['grad_m', 'grad_c'] },
    grad_m: { type: 'metric', props: { label: 'Grad norm', value: round(m.gradNorm), unit: m.clipped ? 'clipped at 5.0' : `clip ${CLIP.toFixed(1)}` } },
    grad_c: { type: 'chart', props: { kind: 'line', x_axis: 'number', series: [series('grad', 'grad norm · max', grad)] } },
  }
  const spec: UiSurfaceSpec = {
    version: UI_SPEC_VERSION, surface_id: 'training_metrics', title: 'r14 · 1.3B SFT', kind: 'native', root: 'root', elements,
    fallback: `SIMULATED training run r14 at step ${s} of ${TOTAL_STEPS}: train loss ${fmt(m.trainLoss)}, reward ${fmt(m.reward, 2)}, grad norm ${m.gradNorm.toFixed(2)}${lastEval ? `, val loss ${fmt(lastEval.valLoss)} at checkpoint ${lastEval.step}` : ''}.`,
  }
  const perChart = {
    loss: train.length + valPts.length, quality: reward.length + accPts.length, speed: tok.length, grad: grad.length,
  }
  return { spec, points: Object.values(perChart).reduce((a, b) => a + b, 0), perChart }
}

/** The checkpoints table: every eval, newest first; the one under way says how far it is. */
export function evalsSpec(sim: SimState): UiSurfaceSpec {
  const s = sim.step
  const sched = scheduleAt(s)
  const done = evalsDone(s).map((k) => evalOf(sim.seed, k)).reverse().slice(0, 9)
  const rows: Record<string, string | number | null>[] = []
  if (sched.evalPhase === 'running' && sched.k > 0) {
    rows.push({ ckpt: thousands(sched.k * CKPT_EVERY), val: null, dval: null, acc: null, reward: null, state: `${Math.round((sched.phaseStep / EVAL_STEPS) * 64)}/64` })
  }
  done.forEach((e, i) => {
    const prev = done[i + 1]
    rows.push({ ckpt: thousands(e.step), val: round(e.valLoss), dval: prev ? round(e.valLoss - prev.valLoss) : null, acc: Number((e.acc * 100).toFixed(1)), reward: round(e.reward), state: 'done' })
  })
  // the table's own numbers: a column of numbers reads right-aligned only when every cell is a number or absent
  const cleaned = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null))) as Record<string, string | number>[]
  return {
    version: UI_SPEC_VERSION, surface_id: 'checkpoint_evals', title: 'Checkpoint evals', kind: 'native', root: 'root',
    elements: {
      root: { type: 'stack', children: ['t'] },
      t: { type: 'table', props: { columns: [{ key: 'ckpt', label: 'Step' }, { key: 'val', label: 'Val loss' }, { key: 'dval', label: 'Δ val' }, { key: 'acc', label: 'Acc %' }, { key: 'reward', label: 'Reward' }, { key: 'state', label: 'State' }], rows: cleaned } },
    },
    fallback: `SIMULATED checkpoint evals: ${done.length} done${done[0] ? `, latest step ${done[0].step} val loss ${fmt(done[0].valLoss)}` : ''}.`,
  }
}

/** A surface record as the server would send it: the anchor (the trainer's run), the run that wrote this revision. */
export function surfaceRecord(spec: UiSurfaceSpec, revision: number, writer: string, createdAt: number, now: number): UiSurfaceRecord {
  return {
    session_id: DEMO_SESSION, run_id: TRAINER_RUN, surface_id: spec.surface_id, scope: 'session', updated_by_run_id: writer, revision,
    spec, state: {}, model: DEMO_MODEL, created_at: iso(createdAt), updated_at: iso(now),
  }
}

/** The run that writes the surfaces at this step: the eval under way, else the latest one. */
export function surfaceWriter(sim: SimState): string {
  const { k } = scheduleAt(sim.step)
  return k > 0 ? evalRunId(k) : TRAINER_RUN
}
