/** The live UI demo's simulator: a training run's metrics and its agents' schedule as pure functions of the training
 *  step and a seed. SIMULATED — nothing here reads a real run; every number is generated.
 *
 *  Shapes, not rules: the loss falls on two time constants with slow drift (smooth value noise), per-step jitter and a
 *  rare spike that decays; the gradient norm spikes with it and is clipped; validation lands only after its eval ends
 *  (a lag) and drifts up late (mild overfit); throughput dips while an eval shares the GPUs and is absent while a
 *  checkpoint is written (a gap). Determinism: a value depends on (seed, step) only, so a reset or a different tick
 *  size draws the same curve. */

export const TICK_MS = 500
/** training steps per tick at 1x (2 Hz ticks: 8 steps a second) */
export const STEPS_PER_TICK = 4
export const TOTAL_STEPS = 12_000
export const CKPT_EVERY = 250
/** an eval of a checkpoint runs this many training steps after the checkpoint; its numbers land when it ends */
export const EVAL_STEPS = 120
/** the report agent waits for the eval, then works this many steps */
export const REPORT_STEPS = 90
/** a checkpoint every this many steps is written to disk: the throughput has no value meanwhile */
export const SAVE_EVERY = 1_000
export const SAVE_STEPS = 10
export const CLIP = 5
/** where a run starts (and a reset returns): an eval under way and a report queued, from the first frame */
export const START_STEP = 24 * CKPT_EVERY + 40
export const DEFAULT_SEED = 14

/** 32-bit integer hash of (seed, n) to [0, 1). */
export function hash(seed: number, n: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(n | 0, 0x85ebca77)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

/** smooth value noise in [0, 1): hashed knots every `period` steps, eased between */
export function smooth(seed: number, x: number, period: number): number {
  const i = Math.floor(x / period)
  const f = x / period - i
  const e = f * f * (3 - 2 * f)
  return hash(seed, i) * (1 - e) + hash(seed, i + 1) * e
}

const centered = (v: number) => (v - 0.5) * 2

/** the loss the run would have without noise or spikes */
export function lossTrend(s: number): number {
  return 0.58 + 2.05 * Math.exp(-s / 950) + 0.42 * Math.exp(-s / 160)
}

/** the spike of the block of 1,500 steps that holds `s`: where it starts and how big it is */
export function spikeOf(seed: number, s: number): { at: number; amp: number } {
  const k = Math.floor(s / 1_500)
  return { at: k * 1_500 + 300 + Math.floor(hash(seed + 3, k) * 900), amp: 0.32 + 0.42 * hash(seed + 4, k) }
}

function spikeAt(seed: number, s: number, decay: number): number {
  const { at, amp } = spikeOf(seed, s)
  return s >= at ? amp * Math.exp(-(s - at) / decay) : 0
}

export interface StepMetrics {
  step: number
  trainLoss: number
  reward: number
  /** thousands of tokens a second; null while a checkpoint is written */
  tokPerSec: number | null
  /** after clipping */
  gradNorm: number
  clipped: boolean
}

export function stepMetrics(seed: number, s: number): StepMetrics {
  const base = lossTrend(s)
  const spike = spikeAt(seed, s, 45)
  const trainLoss = base + 0.045 * centered(smooth(seed + 5, s, 64)) + 0.02 * centered(smooth(seed + 7, s, 17))
    + 0.05 * (hash(seed + 1, s) - 0.5) * (0.5 + base / 3) + spike
  const rawGrad = 0.42 + 1.6 * Math.exp(-s / 700) + 0.12 * centered(smooth(seed + 11, s, 30)) + 0.1 * hash(seed + 12, s) + spikeAt(seed, s, 12) * 14
  const reward = 0.18 + 0.62 * (1 - Math.exp(-s / 1_600)) + 0.06 * centered(smooth(seed + 21, s, 90)) + 0.09 * (hash(seed + 22, s) - 0.5) - spike * 0.35
  const phase = s % CKPT_EVERY
  const saving = s % SAVE_EVERY < SAVE_STEPS
  // a slow node now and then: a short dip
  const slowNoise = smooth(seed + 41, s, 120)
  const slow = slowNoise > 0.86 ? (6.5 * (slowNoise - 0.86)) / 0.14 : 0
  const tok = 41.6 + 1.2 * centered(smooth(seed + 31, s, 40)) + 0.8 * (hash(seed + 32, s) - 0.5) - (phase < EVAL_STEPS ? 4.6 : 0) - slow
  return { step: s, trainLoss, reward: Math.max(0, Math.min(1, reward)), tokPerSec: saving ? null : tok, gradNorm: Math.min(rawGrad, CLIP), clipped: rawGrad > CLIP }
}

export interface EvalResult { k: number; step: number; valLoss: number; acc: number; reward: number }

/** the eval of checkpoint k (its numbers; when they are known is the schedule's) */
export function evalOf(seed: number, k: number): EvalResult {
  const s = k * CKPT_EVERY
  const valLoss = lossTrend(s) + 0.07 + 0.000035 * Math.max(0, s - 5_200) + 0.03 * (hash(seed + 51, k) - 0.5) + spikeAt(seed, s, 45) * 0.6
  const acc = 0.885 - 0.47 * Math.exp(-s / 1_250) + 0.014 * (hash(seed + 52, k) - 0.5)
  const reward = 0.2 + 0.6 * (1 - Math.exp(-s / 1_500)) + 0.03 * (hash(seed + 53, k) - 0.5)
  return { k, step: s, valLoss, acc, reward }
}

/** checkpoints whose eval has ended by step s (k ≥ 1), oldest first */
export function evalsDone(s: number): number[] {
  const out: number[] = []
  for (let k = 1; k * CKPT_EVERY + EVAL_STEPS <= s; k++) out.push(k)
  return out
}

// ---- aggregation for the charts ----------------------------------------------------------------------------------

export type Agg = 'mean' | 'max'

/** One series' points over the window ending at `s`: buckets of `stride` steps aligned to absolute steps (a sliding
 *  window never re-buckets what it already drew), each the mean (or the max: a spike must stay visible) of its steps;
 *  a bucket mostly without a value (a checkpoint being written) is a gap (null). x is the bucket's last step. */
export function bucketed(s: number, window: number, stride: number, pick: (m: StepMetrics) => number | null, agg: Agg, seed: number): { x: number; value: number | null }[] {
  const out: { x: number; value: number | null }[] = []
  const lo = Math.max(0, s - window)
  const first = Math.floor(lo / stride) * stride
  for (let b = first; b <= s; b += stride) {
    const end = Math.min(b + stride - 1, s)
    let n = 0, acc = agg === 'max' ? Number.NEGATIVE_INFINITY : 0, missing = 0
    for (let i = b; i <= end; i++) {
      const v = pick(stepMetrics(seed, i))
      if (v === null) { missing++; continue }
      n++
      acc = agg === 'max' ? Math.max(acc, v) : acc + v
    }
    const value = n === 0 || missing > n ? null : agg === 'max' ? acc : acc / n
    out.push({ x: end, value: value === null ? null : round(value) })
  }
  return out
}

export function round(v: number): number {
  const a = Math.abs(v)
  const digits = a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4
  return Number(v.toFixed(digits))
}

// ---- the simulation's own state ------------------------------------------------------------------------------------

export type Speed = 1 | 4

export interface SimState {
  seed: number
  /** ticks run since the start (a reset sets it back to 0) */
  tick: number
  step: number
  speed: Speed
  paused: boolean
  /** when tick 0 happened (epoch ms) */
  startedAt: number
  /** the wall time of each tick's step, oldest first (for the runs' times); before the first, 1x is assumed */
  marks: { step: number; at: number }[]
}

export function createSim(now: number, seed = DEFAULT_SEED, startStep = START_STEP): SimState {
  return { seed, tick: 0, step: startStep, speed: 1, paused: false, startedAt: now, marks: [{ step: startStep, at: now }] }
}

export const stepsPerSecond = (speed: Speed) => (STEPS_PER_TICK * speed * 1000) / TICK_MS

/** One tick: the run moves on (nothing moves while paused, or past the planned end). */
export function advance(sim: SimState, now: number): SimState {
  if (sim.paused || sim.step >= TOTAL_STEPS) return sim
  const step = Math.min(TOTAL_STEPS, sim.step + STEPS_PER_TICK * sim.speed)
  const marks = [...sim.marks, { step, at: now }]
  if (marks.length > 4_000) marks.splice(0, marks.length - 4_000)
  return { ...sim, tick: sim.tick + 1, step, marks }
}

/** When the run passed `step` (epoch ms): from the ticks' marks, else extrapolated at 1x before the first mark. */
export function timeOfStep(sim: SimState, step: number): number {
  const m = sim.marks
  if (step <= m[0]!.step) return m[0]!.at - ((m[0]!.step - step) / stepsPerSecond(1)) * 1000
  for (let i = 1; i < m.length; i++) {
    if (m[i]!.step >= step) {
      const a = m[i - 1]!, b = m[i]!
      return b.step === a.step ? b.at : a.at + ((step - a.step) / (b.step - a.step)) * (b.at - a.at)
    }
  }
  return m[m.length - 1]!.at
}

// ---- the agents' schedule -------------------------------------------------------------------------------------------

export type Phase = 'queued' | 'running' | 'done'

export interface Schedule {
  /** the checkpoint the current block started at */
  k: number
  phaseStep: number
  /** the eval of checkpoint k: running for the first EVAL_STEPS steps of the block, else done */
  evalPhase: Phase
  /** the report on checkpoint k: queued behind the eval, then running, then done */
  reportPhase: Phase
}

export function scheduleAt(step: number): Schedule {
  const k = Math.floor(step / CKPT_EVERY)
  const phaseStep = step - k * CKPT_EVERY
  return {
    k, phaseStep,
    evalPhase: phaseStep < EVAL_STEPS ? 'running' : 'done',
    reportPhase: phaseStep < EVAL_STEPS ? 'queued' : phaseStep < EVAL_STEPS + REPORT_STEPS ? 'running' : 'done',
  }
}
