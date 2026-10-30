/** FIXTURES of the Intelligent UI interaction e2e (frontend/e2e/intelligent-ui-app.e2e.ts) and of its backend
 *  (backend-ts/scripts/ui_e2e_server.ts). A module, not a test: importing it runs nothing and starts nothing; Node (the
 *  test) and Bun (the server) both import it, so the numbers the scripted model computes and the numbers the test
 *  expects come from one function.
 *
 *  The surfaces and the form are the owner-facing demos in docs/intelligent-ui-demos/ (the html surface names its
 *  document with html_file, read here from the same folder): what the e2e drives is what the docs show.
 *
 *  Everything a "model" does in these tests is a SCRIPTED MODEL (backend-ts/src/llm/scripted.ts) whose tool calls are
 *  written in advance. It proves the harness's path — tool call → RunManager → DB → REST → SSE → bridge → page — and
 *  nothing about whether a real model would choose these tools. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEMOS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'intelligent-ui-demos')

const readJson = (name: string) => JSON.parse(readFileSync(join(DEMOS_DIR, name), 'utf8')) as Record<string, unknown>

/** The native Flow-GRPO planner (run actions estimate / ask_estimate / sweep / check, the draft action explain). */
export function nativePlannerSpec(): Record<string, unknown> {
  return readJson('flow-grpo-native.spec.json')
}

/** The html Flow-GRPO demo as the docs keep it (with html_file). */
export function htmlDemoSpecOnDisk(): Record<string, unknown> {
  return readJson('flow-grpo-html.spec.json')
}

/** The html demo as present_ui is called with it in the e2e: the document of html_file put in `html` (the e2e's
 *  session has no folder holding the file; present_ui's own html_file path reads the working folder). */
export function htmlDemoSpec(): Record<string, unknown> {
  const { html_file: file, ...rest } = htmlDemoSpecOnDisk()
  return { ...rest, html: readFileSync(join(DEMOS_DIR, String(file)), 'utf8') }
}

/** request_input's arguments: a multi-select, a number, a text and a checkbox; two of them required. */
export function requestInputForm(): Record<string, unknown> {
  return readJson('flow-grpo-request-input.json')
}

/** The form the scripted task of ask_estimate shows with request_input (a run action's agent asking mid-task). */
export const ASK_ESTIMATE_FORM = {
  title: 'Estimate setup',
  root: 'form',
  elements: {
    form: { type: 'stack', children: ['prompts', 'focus'] },
    prompts: { type: 'input', props: { label: 'Prompts per step for this estimate', key: 'prompts', inputType: 'number', min: 1, max: 512 } },
    focus: { type: 'select', props: { label: 'Focus', key: 'focus', options: [{ label: 'GPU cost', value: 'cost' }, { label: 'Stability', value: 'stability' }] } },
  },
  initial_state: { prompts: null, focus: null },
  required: ['prompts', 'focus'],
  submit_label: 'Use these',
} as const

export const NATIVE_SURFACE = 'grpo_plan'
export const HTML_SURFACE = 'flow_grpo'
export const FORM_TITLE = 'Flow-GRPO comparison setup'
export const FORM_SUBMIT = 'Start comparison'

/** Words in the person's message that the scripted routes read (the e2e types them into the real composer). */
export const WORDS = {
  native: 'show the Flow-GRPO planner',
  html: 'show the Flow-GRPO html demo',
  /** a turn that holds the conversation (gate "turn") until the test releases it: a UI task meanwhile is queued */
  holdTurn: 'HOLD_TURN keep the conversation busy',
  ask: 'ask me for the comparison setup',
} as const

/** Named points where a scripted run waits for the test (POST /e2e/gate?name=&op=arm|release|disarm). An armed
 *  point holds the next run that reaches it; an unarmed one is passed at once. "turn" and "sweep" always hold. */
export const GATES = {
  /** a task run, after its first return_ui_result and before its final answer */
  afterData: 'task-after-data',
  /** the conversation turn of WORDS.holdTurn */
  turn: 'turn',
  /** the sweep task, after its first data, until released or stopped. An INTERACTION FIXTURE for Stop: the scripted
   *  sweep sends one point and waits; it sweeps nothing. */
  sweep: 'sweep',
} as const

export interface PlannerValues { group_size: number; prompts: number; sde_steps: number; kl_beta?: number; noise?: number; focus?: string }

/** FIXTURE ARITHMETIC (not a measurement of anything): the demo's per-evaluation seconds, as the html demo's action
 *  prompt spells them out — sampling = evals × 0.05, reward = rollouts × 0.02, update = evals × 0.03 (one decimal),
 *  gpu_hours = their sum × 100 / 3600 (two decimals). `focus` is echoed; it changes nothing in the arithmetic. */
export function grpoEstimate(values: PlannerValues, input: { focus?: unknown } | null = null) {
  const rollouts = values.prompts * values.group_size
  const evals = rollouts * values.sde_steps
  const r1 = (x: number) => Math.round(x * 10) / 10
  const phases = [
    { label: 'sampling', value: r1(evals * 0.05) },
    { label: 'reward', value: r1(rollouts * 0.02) },
    { label: 'update', value: r1(evals * 0.03) },
  ]
  const perStep = phases.reduce((s, p) => s + p.value, 0)
  return {
    rollouts_per_step: rollouts,
    sde_evals_per_step: evals,
    gpu_hours: Math.round((perStep * 100 / 3600) * 100) / 100,
    phases,
    focus: typeof input?.focus === 'string' ? input.focus : values.focus ?? null,
    received: { group_size: values.group_size, prompts: values.prompts, sde_steps: values.sde_steps, kl_beta: values.kl_beta ?? null, noise: values.noise ?? null },
  }
}

/** The planner's limit the "check" action reports as a failure: a threshold chosen for the demo (the native spec's
 *  prompt and text say so), not a theoretical bound. */
export const KL_LIMIT = 0.5

/** The final answers' markers (the scripted routes write them, the test reads them on the page). */
export const MARK = {
  estimate: 'ESTIMATE_DONE',
  sweepStarted: 'SWEEP_STARTED',
  check: 'CHECK_DONE',
  ask: 'ASK_RESULT',
  shown: 'UI_SHOWN',
  turnReleased: 'TURN_RELEASED',
} as const
