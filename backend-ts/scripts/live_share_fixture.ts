/** The live session share's scripted route for the browser e2e (frontend/e2e/live-share.e2e.ts), served by
 *  scripts/e2e_server.ts. Test-only: nothing here is part of the product, nothing reaches a network.
 *
 *  `scripted:live` reads the person's latest words for its case (LIVE_CASES) and only this turn's own history (never a
 *  shared step count), so any case can run after any other:
 *  - PLAIN <mark>: one answer naming the mark.
 *  - QUICK <mark>: one harmless command, then an answer naming the mark.
 *  - PROGRESS: held before its first words (gate live-start), so the link can be made while it is active; then
 *      1. its intro and a read of calc.py;
 *      2. a sensitive command — it writes and reads a dotenv file of its own, writes an opaque auth file, and dumps a
 *         cleared environment (only the synthetic variable in it) — that runs for two seconds (a running tool to see);
 *      3. a read of that auth file (a sensitive path);
 *      4. a harmless command that prints a bearer header and its own mark, for two seconds;
 *      5. held again (gate live-answer), then the answer streamed in pieces, each held (gates live-piece-<k>): every
 *         secret of it is cut between two pieces (live_share_canaries.ts: liveAnswerPieces).
 *  Every value is synthetic (live_share_canaries.ts).
 *
 *  `scripted:task` (TASK_ROUTE) plays the sessions of a task for the task share's tests (session-share.e2e.ts and
 *  live-share.e2e.ts; the TASK_* values below), stateless the same way:
 *  - MARK <mark>: one answer naming the mark (and a synthetic mailbox and home path, redacted by every share);
 *  - TOOL <mark>: one harmless command printing a bearer header (redacted) and the mark, then the answer;
 *  - HOLD <mark>: held before its answer (gate task-hold-<mark>): the session works until the test releases it.
 *
 *  `scripted:task-planner` (TASK_PLANNER) is a director that plans: asked for the plan of an interaction it controls
 *  (the planning turn's App note — director.v1 "Plan interaction <ix>", later surfaces "Interaction <ix> has no plan
 *  yet"), it calls `schedule` once with one step per participant the note lists, each on its own copy, then stops (the
 *  person decides); any other turn it answers in words. The interaction is the product's own (POST
 *  /api/sessions/:id/interactions with a director_model and no plan): controller `director`, a plan row in the tree. */

import { ModelConfig } from '../src/config.ts'
import {
  isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, toolReturns, userTexts,
  type ModelMessage, type ModelResponse, type RequestUsage, type ResponsePart, type ToolCallPart,
} from '../src/llm/messages.ts'
import type { Model, ModelProfile, ModelRequestParameters, ModelSettings, RequestContext, StreamEvent, StreamedResponse } from '../src/llm/model.ts'
import { LIVE_CASES, LIVE_GATES, LIVE_MARKS, LIVE_SECRETS, liveAnswerPieces } from './live_share_canaries.ts'

export const LIVE_ROUTE = 'scripted:live'

// ---- the task share's synthetic values (session-share.e2e.ts and live-share.e2e.ts restate them: change them in all
// three places). Values shaped like a credential, a home path or a mailbox are put together at run time from pieces
// that hold no such shape (scripts/oss/lib/scan.mjs finds nothing); the people are Carol, Dave, Erin and Frank.

const joinTask = (...pieces: string[]): string => pieces.join('')

/** The route the task fixtures run (live_share_fixture.ts). */
export const TASK_ROUTE = 'scripted:task'

/** The task fixtures' planning director (a director-controlled interaction's plan). */
export const TASK_PLANNER = 'scripted:task-planner'

/** The words that pick a case of `scripted:task` (each a marker in the person's message, followed by its mark):
 *  - MARK <mark>: one answer naming the mark, the session's mailbox and home path (both redacted in any share);
 *  - TOOL <mark>: one harmless command that prints a bearer header (redacted) and the mark, then the answer;
 *  - HOLD <mark>: held before its answer (gate TASK_GATES.hold(mark)), so a session of the task is active. */
export const TASK_CASES = { mark: 'TASK_CASE_MARK', tool: 'TASK_CASE_TOOL', hold: 'TASK_CASE_HOLD' } as const

/** The gates of `scripted:task` (released by the test: POST /e2e/ui-release?gate=<name> on the APP's port). */
export const TASK_GATES = {
  hold: (mark: string): string => `task-hold-${mark.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
} as const

/** The sessions of the fixtures, by role. `root` is the task's first session; `a` joins it from the same project; `b`
 *  joins it (through `a`) from ANOTHER project; `c` joins it and is deleted; `side` is a task of its own; `late` joins
 *  the live task after its link was made; `k*` are the capacity task's. */
export type TaskRole = 'root' | 'a' | 'b' | 'c' | 'side' | 'late'

export const TASK_TITLES: Record<TaskRole, string> = {
  root: 'Task root · Carol plans (synthetic)',
  a: 'Member A · Dave builds (synthetic)',
  b: 'Member B · Erin reviews elsewhere (synthetic)',
  c: 'Member C · deleted later (synthetic)',
  side: 'Side task · Frank alone (synthetic)',
  late: 'Member D · joined later (synthetic)',
}

/** Each session's own mark: present in its own session's share, never in another's. A deleted session's and the side
 *  task's marks must never be in a task share. */
export const TASK_MARKS: Record<TaskRole, string> = {
  root: 'TASKROOTMARK_1c4e',
  a: 'TASKMEMBERAMARK_7b2d',
  b: 'TASKMEMBERBMARK_3f9a',
  c: 'TASKDELETEDMARK_5e0c',
  side: 'TASKSIDEMARK_8d1b',
  late: 'TASKLATEMARK_2a6f',
}

/** Each session's picture: its own size (the share's re-encoded picture keeps it), so a picture shown is known to be
 *  the session's by its natural size alone, whatever its key (every session's first picture is `img1`); its own colour;
 *  its own metadata canary in a tEXt chunk (stripped by any share). */
export const TASK_IMAGES: Record<TaskRole, { w: number; h: number; rgb: [number, number, number]; meta: string }> = {
  root: { w: 30, h: 18, rgb: [210, 40, 40], meta: 'TASKPNGMETAROOT_9a1f' },
  a: { w: 18, h: 30, rgb: [40, 170, 60], meta: 'TASKPNGMETAA_4c7e' },
  b: { w: 26, h: 26, rgb: [40, 70, 210], meta: 'TASKPNGMETAB_6d2b' },
  c: { w: 22, h: 14, rgb: [200, 160, 30], meta: 'TASKPNGMETAC_1e8a' },
  side: { w: 20, h: 20, rgb: [150, 40, 170], meta: 'TASKPNGMETASIDE_3b5c' },
  late: { w: 14, h: 22, rgb: [30, 160, 170], meta: 'TASKPNGMETALATE_7f0d' },
}

/** a synthetic account name (only ever written into a path at run time) */
export const TASK_HOME_USER = joinTask('tasksyn', 'thusr')

/** Values that must never reach a share (offline file or live viewer), whole: built at run time. */
export const TASK_SECRETS = {
  mail_local: joinTask('carol', '.synthetic'),
  mail: joinTask('carol', '.synthetic', '@', 'example', '.org'),
  home: joinTask('/', 'Users', '/', TASK_HOME_USER, '/plans/task-notes.md'),
  home_user: TASK_HOME_USER,
  bearer: joinTask('TASKBEARER', 'abcdef0123456789'),
} as const

/** The work order of the task's first session (the Agent Teams card's row with two runs once it is continued). */
export const TASK_ORDER = { label: 'Team order · Carol', follow_up: 'Team order · Carol, once more' } as const

/** The words of the director's member session (scripted:dir hands them to Scripted Worker). */
export const TASK_DIRECTOR_WORDS = 'have someone do the work for the task (synthetic)'

/** The `scripted:task` answer of a case, for a mark (the e2e reads it back). */
export function taskAnswer(mark: string): string {
  return `Carol noted ${mark} for Dave. Write to ${TASK_SECRETS.mail}; notes in ${TASK_SECRETS.home}.`
}

/** A gate the test releases (scripts/e2e_server.ts: POST /e2e/ui-release?gate=<name>, on the app's own port only). */
export type Hold = (gate: string) => Promise<void>

/** One step of the route: text streamed in pieces (piece k+1 waits for gates[k]), then tool calls; `before` is a gate
 *  waited for before anything streams. */
interface LiveStep { before?: string; pieces: string[]; gates?: string[]; tools?: ToolCallPart[] }

const USAGE: RequestUsage = { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 }

function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return Promise.race([p, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true }))])
}

let callIds = 0

/** A model that streams its text in the pieces its step names, waiting for a gate between two pieces: what the app
 *  publishes while an answer is half written is what a viewer may see, so the test holds it there. */
export class LiveScriptModel implements Model {
  readonly model_name: string
  readonly system = 'anthropic'
  readonly profile: ModelProfile = { supports_thinking: false }
  constructor(private readonly script: (messages: ModelMessage[]) => LiveStep, private readonly hold: Hold, name: string) { this.model_name = name }

  private response(step: LiveStep): ModelResponse {
    const parts: ResponsePart[] = []
    const text = step.pieces.join('')
    if (text) parts.push(textPart(text, { provider_name: this.system }))
    for (const t of step.tools ?? []) parts.push({ ...t, provider_name: this.system })
    return modelResponse(parts, { usage: USAGE, model_name: this.model_name, provider_name: this.system })
  }

  async request(messages: ModelMessage[], _s: ModelSettings, _p: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse> {
    const step = this.script(messages)
    if (step.before) await abortable(this.hold(step.before), ctx?.signal)
    for (const g of step.gates ?? []) await abortable(this.hold(g), ctx?.signal)
    return this.response(step)
  }

  async requestStream(messages: ModelMessage[], _s: ModelSettings, _p: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    const step = this.script(messages)
    if (step.before) await abortable(this.hold(step.before), ctx?.signal)
    const tools = (step.tools ?? []).map((t) => ({ ...t, tool_call_id: t.tool_call_id || `call_live_${++callIds}` }))
    const full = this.response({ ...step, tools })
    const hold = this.hold
    const signal = ctx?.signal
    return {
      model_name: this.model_name,
      usage: () => USAGE,
      get: () => full,
      async *events(): AsyncGenerator<StreamEvent, void, undefined> {
        let index = 0
        if (step.pieces.length && step.pieces.join('')) {
          const i = index++
          yield { type: 'part_start', index: i, part: textPart(step.pieces[0]!, { provider_name: 'anthropic' }) }
          for (let k = 1; k < step.pieces.length; k++) {
            const gate = step.gates?.[k - 1]
            if (gate) await abortable(hold(gate), signal)
            yield { type: 'part_delta', index: i, delta: { part_kind: 'text', content_delta: step.pieces[k]! } }
          }
          yield { type: 'part_end', index: i, part: full.parts[0]! }
        }
        for (const t of full.parts.filter((p): p is ToolCallPart => p.part_kind === 'tool-call')) {
          const i = index++
          yield { type: 'part_start', index: i, part: { ...t, args: '' } }
          yield { type: 'part_delta', index: i, delta: { part_kind: 'tool-call', args_delta: typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? {}) } }
          yield { type: 'part_end', index: i, part: t }
        }
      },
    }
  }
}

/** This turn: the messages from the person's latest words on. */
function thisTurn(messages: ModelMessage[]): ModelMessage[] {
  const at = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
  return messages.slice(Math.max(0, at))
}

const markAfter = (words: string, kase: string): string => new RegExp(`${kase}\\s+(\\S+)`).exec(words)?.[1] ?? 'NO_MARK'

/** The route's script (exported for a unit check of its steps). */
export function liveScript(messages: ModelMessage[]): LiveStep {
  const turn = thisTurn(messages)
  const words = userTexts(turn.slice(0, 1)).join('\n')
  const done = toolReturns(turn).length
  const S = LIVE_SECRETS
  if (words.includes(LIVE_CASES.plain)) return { pieces: [`Alice noted ${markAfter(words, LIVE_CASES.plain)} for Bob.`] }
  if (words.includes(LIVE_CASES.quick)) {
    const mark = markAfter(words, LIVE_CASES.quick)
    if (done === 0) return { pieces: ['Bob asked for one more check.'], tools: [toolCallPart('bash', { command: `echo checked-${mark.toLowerCase()}`, wait_s: 30 }, '')] }
    return { pieces: [`Bob, update: ${mark}.`] }
  }
  if (words.includes(LIVE_CASES.progress)) {
    switch (done) {
      case 0: return { before: LIVE_GATES.start, pieces: [`${LIVE_MARKS.intro}.`], tools: [toolCallPart('read_file', { path: 'calc.py' }, '')] }
      case 1: return {
        pieces: [`${LIVE_MARKS.sensitive_intro}.`],
        tools: [toolCallPart('bash', {
          command: `printf 'SYNTH_LIVE_SECRET=${S.dotenv}\\n' > .env.live && cat .env.live && printf '{"refresh":"${S.auth}"}' > auth.json && env -i SYNTH_LIVE_ENV=${S.env} printenv && sleep 2`,
          wait_s: 30,
        }, '')],
      }
      case 2: return { pieces: [], tools: [toolCallPart('read_file', { path: 'auth.json' }, '')] }
      case 3: return {
        pieces: ['Now a harmless check Bob can see.'],
        tools: [toolCallPart('bash', { command: `echo "Authorization: Bearer ${S.tool_bearer}"; sleep 2; echo ${LIVE_MARKS.tool_mark}`, wait_s: 30 }, '')],
      }
      default: {
        const pieces = liveAnswerPieces()
        return { before: LIVE_GATES.answer, pieces, gates: pieces.slice(1).map((_, k) => LIVE_GATES.piece(k)) }
      }
    }
  }
  return { pieces: ['Alice has nothing to do for this message.'] }
}

/** `scripted:task`'s script (exported for a unit check of its steps). */
export function taskScript(messages: ModelMessage[]): LiveStep {
  const turn = thisTurn(messages)
  const words = userTexts(turn.slice(0, 1)).join('\n')
  const done = toolReturns(turn).length
  if (words.includes(TASK_CASES.hold)) return { before: TASK_GATES.hold(markAfter(words, TASK_CASES.hold)), pieces: [taskAnswer(markAfter(words, TASK_CASES.hold))] }
  if (words.includes(TASK_CASES.tool)) {
    const mark = markAfter(words, TASK_CASES.tool)
    if (done === 0) return { pieces: ['Dave runs one check.'], tools: [toolCallPart('bash', { command: `echo "Authorization: Bearer ${TASK_SECRETS.bearer}"; echo ${mark}`, wait_s: 30 }, '')] }
    return { pieces: [taskAnswer(mark)] }
  }
  if (words.includes(TASK_CASES.mark)) return { pieces: [taskAnswer(markAfter(words, TASK_CASES.mark))] }
  return { pieces: ['Carol has nothing to do for this message.'] }
}

/** `scripted:task-planner`'s script (exported for a unit check of its steps). */
export function plannerScript(messages: ModelMessage[]): LiveStep {
  const turn = thisTurn(messages)
  const words = userTexts(turn.slice(0, 1)).join('\n')
  const ix = /Interaction (ix_[0-9a-z]+) has no plan yet/.exec(words)?.[1] ?? /Plan interaction (ix_[0-9a-z]+)/.exec(words)?.[1] ?? null
  if (ix === null) return { pieces: ['The planner has nothing to plan in this message.'] }
  if (toolReturns(turn).some((p) => p.tool_name === 'schedule')) return { pieces: ['Planned: every participant once, then your choice.'] }
  // the roster the note lists ("- <id>: <label> (<model>)"), read from its Participants block when it has one
  const roster = /Participants \(\d+\):\n([\s\S]*?)(?:\n[A-Z][^\n]*:|$)/.exec(words)?.[1] ?? words
  const ids = [...new Set([...roster.matchAll(/^- ([A-Za-z0-9_-]+): /gm)].map((m) => m[1]!))]
  const nodes = ids.map((participant, i) => ({ id: `s${i + 1}`, participant, workspace: 'own' }))
  return { pieces: ['Carol plans one step for each participant.'], tools: [toolCallPart('schedule', { interaction_id: ix, nodes, then: 'stop' }, '')] }
}

/** The route's catalogue entry and model (the gates are the e2e server's own). */
export function liveShareRoutes(hold: Hold): { config: ModelConfig[]; models: Record<string, Model> } {
  return {
    // takes images: the e2e session's history carries the uploaded picture (an earlier turn, scripted:e), and every later
    // turn of this route on that session hands the conversation back with it (as scripted:img declares)
    config: [
      new ModelConfig({ id: LIVE_ROUTE, label: 'Scripted Live', provider: 'anthropic', model: 'scripted-live', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } }),
      // the task share's route: its sessions carry uploaded pictures too
      new ModelConfig({ id: TASK_ROUTE, label: 'Scripted Task', provider: 'anthropic', model: 'scripted-task', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } }),
      // the task share's planning director (a director-controlled interaction: its plan row, the steps under it)
      new ModelConfig({ id: TASK_PLANNER, label: 'Scripted Planner', provider: 'anthropic', model: 'scripted-task-planner', api_key_env: 'OASIS_TEST_KEY_A' }),
    ],
    models: {
      [LIVE_ROUTE]: new LiveScriptModel(liveScript, hold, 'scripted-live'), [TASK_ROUTE]: new LiveScriptModel(taskScript, hold, 'scripted-task'),
      [TASK_PLANNER]: new LiveScriptModel(plannerScript, hold, 'scripted-task-planner'),
    },
  }
}
