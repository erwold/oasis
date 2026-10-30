/** A backend for frontend/e2e/intelligent-ui-app.e2e.ts (Intelligent UI interaction: run actions, the html bridge's
 *  tasks, request_input): the real app (createApp: RunManager, the tools, SQLite, REST, SSE, the built UI) on a fresh
 *  data directory, with SCRIPTED MODELS in place of providers. Nothing reaches a cloud: the scripted routes are the
 *  only models, the global fetch refuses every host but the loopback, and the data directory (auth, keys, database)
 *  is a new temporary folder — never the person's ~/.oasis-code.
 *
 *  The isolation runtime is not probed (`probe: false`, a path the product has: the report says `unavailable` and
 *  bash refuses). No fake runtime, no faked isolation report: nothing here runs a command, and the suite asserts the
 *  report is `unavailable` — it proves the UI paths, never the OS sandbox (frontend/e2e/ui.e2e.ts keeps that gate).
 *
 *  It listens on 127.0.0.1 at a free port (port 0, so it can run beside the other e2e files) and prints one JSON line
 *  first on stdout: { port, token, data, isolation }.
 *
 *      bun run scripts/ui_e2e_server.ts
 *
 *  Test-only routes, behind `authorization: Bearer <token>` (the app's own routes are untouched; every other request
 *  goes to the app's fetch with the server as its second argument — the app reads the caller's address from it):
 *    POST /e2e/gate?name=&op=arm|release|disarm — hold a scripted run at a named point (GATES), or let it go
 *    GET  /e2e/seen — what the scripted models were handed in each task turn and each request_input answer */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelConfig, Settings, type HarnessConfig } from '../src/config.ts'
import {
  isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, toolReturns,
  type ModelMessage, type ModelRequest, type ModelResponse,
} from '../src/llm/messages.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { createApp } from '../src/main.ts'
import { installNetworkGuard } from '../tests/network_guard.ts'
import {
  ASK_ESTIMATE_FORM, GATES, grpoEstimate, htmlDemoSpec, KL_LIMIT, MARK, nativePlannerSpec, requestInputForm, WORDS, type PlannerValues,
} from '../../frontend/e2e/intelligent-ui-fixtures.ts'

const TOKEN = 'ui-e2e-token'
const rec = (v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

// ---------------------------------------------------------------- gates (the test holds and releases runs)

const armed = new Set<string>()
const waiting = new Map<string, () => void>()

/** Wait at `name` until the test releases it — never for ever (a failed test must not keep the server from closing).
 *  A stopped run's script is abandoned by the scripted model (it races the request's abort signal); its gate times out. */
function hold(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { waiting.delete(name); resolve() }, 90_000)
    waiting.set(name, () => { clearTimeout(timer); waiting.delete(name); resolve() })
  })
}
/** Hold only when the test armed `name` (once). */
async function checkpoint(name: string): Promise<void> {
  if (!armed.delete(name)) return
  await hold(name)
}

// ---------------------------------------------------------------- what the scripted models were handed

interface Seen { model: string; kind: 'task' | 'ask'; action_id?: string; values?: unknown; input?: unknown; prompt_has_values?: boolean; tool_call_id?: string; result?: unknown }
const seen: Seen[] = []

/** This turn: the words of the last request that carries the person's (or the app's) prompt, and what came after. */
function thisTurn(messages: ModelMessage[]): { words: string; since: ModelMessage[] } {
  const at = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
  if (at < 0) return { words: '', since: messages }
  // each piece on its own line: a run's prompt is [the context, the message] (runner buildPrompt), and the message's
  // first line is what a task turn is read by (userText would join the pieces with a space)
  const words = (messages[at] as ModelRequest).parts.filter(isUserPrompt)
    .map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n'))).join('\n')
  // what came after the prompt: a request that carries it may also carry the returns a stopped run's calls were
  // answered with (the history alternates, so the next prompt joins that request) — those are an earlier turn's
  const request = messages[at] as ModelRequest
  const after = request.parts.findLastIndex(isUserPrompt) + 1
  return { words, since: [{ ...request, parts: request.parts.slice(after) }, ...messages.slice(at + 1)] }
}

/** The JSON between <tag> and </tag> in a task's prompt (contract: buildUiActionPrompt's <ui_values>, the task's
 *  <ui_input>); undefined when absent or not JSON. */
function tagged(words: string, tag: string): unknown {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(words)
  if (!m) return undefined
  try { return JSON.parse(m[1]!) } catch { return undefined }
}

const call = (name: string, args: Record<string, unknown>, text?: string): ModelResponse =>
  modelResponse([...(text ? [textPart(text)] : []), toolCallPart(name, args, '')])
const say = (text: string): ModelResponse => modelResponse([textPart(text)])

// ---------------------------------------------------------------- scripted:ui-run (surfaces and their tasks)

/** A turn of the person: present the native planner or the html demo; a HOLD_TURN turn waits at "turn".
 *  A task turn (its prompt is a UI action's, contract buildUiActionPrompt: "[UI action] … (action <id>) …"):
 *    estimate / recompute: return_ui_result with grpoEstimate(values, input), then (gate task-after-data) the answer;
 *    ask_estimate / ask_recompute (the html demo's): request_input (ASK_ESTIMATE_FORM) inside the task's run, then the estimate with the answer's prompts
 *      and focus, then the answer quoting the input's id and its call's id;
 *    sweep: an INTERACTION FIXTURE for Stop — text and one data point, then it waits at "sweep" (it sweeps nothing);
 *    check: return_ui_result ok:false when kl_beta is over KL_LIMIT (a demo threshold), else ok.
 *  The arithmetic is the fixture's grpoEstimate; no answer here is an analysis of anything. */
function uiRunScript(model: string) {
  return async (messages: ModelMessage[]): Promise<ModelResponse> => {
    const { words, since } = thisTurn(messages)
    const action = /^\[UI action\][^\n]*\(action ([A-Za-z][A-Za-z0-9_-]*)\)/m.exec(words)?.[1]
    if (action) return taskTurn(model, action, words, since)
    if (words.includes(WORDS.holdTurn)) {
      await hold(GATES.turn)
      return say(`${MARK.turnReleased}: the conversation is free again.`)
    }
    const shown = rec(toolReturns(since).filter((p) => p.tool_name === 'present_ui').at(-1)?.content)
    if (!shown.status) return call('present_ui', words.includes(WORDS.html) ? htmlDemoSpec() : nativePlannerSpec())
    return say(`${MARK.shown} ${String(shown.surface_id)}: ${String(shown.status)} revision ${String(shown.revision)}.`)
  }
}

async function taskTurn(model: string, action: string, words: string, since: ModelMessage[]): Promise<ModelResponse> {
  const values = rec(tagged(words, 'ui_values')) as unknown as PlannerValues
  const input = tagged(words, 'ui_input') ?? null
  const returns = toolReturns(since)
  const returned = returns.filter((p) => p.tool_name === 'return_ui_result')
  const last = rec(returned.at(-1)?.content)
  // the task turn's first request: what the run was handed
  if (returns.length === 0) seen.push({ model, kind: 'task', action_id: action, values, input, prompt_has_values: words.includes('<ui_values>') })
  // return_ui_result answered something else than ok (not a task run, a refused shape): said plainly, never hidden
  if (returned.length > 0 && last.status !== 'ok') return say(`RETURN_REFUSED ${JSON.stringify(last)}`)
  switch (action) {
    case 'estimate': case 'recompute': {
      const data = grpoEstimate(values, rec(input))
      if (returned.length === 0) return call('return_ui_result', { data, message: 'estimate ready' }, `Estimating group size ${values.group_size}…`)
      await checkpoint(GATES.afterData)
      return say(`${MARK.estimate} group_size=${values.group_size} prompts=${values.prompts} sde_steps=${values.sde_steps} focus=${String(data.focus)} rollouts=${data.rollouts_per_step} gpu_hours=${data.gpu_hours} task=${String(last.task_id)}`)
    }
    case 'ask_estimate': case 'ask_recompute': {
      const asked = returns.filter((p) => p.tool_name === 'request_input').at(-1)
      if (!asked) return call('request_input', ASK_ESTIMATE_FORM, 'Asking for the estimate setup…')
      const answer = rec(asked.content)
      if (returned.length === 0) seen.push({ model, kind: 'ask', tool_call_id: asked.tool_call_id, result: asked.content })
      if (answer.status !== 'submitted') return say(`ASK_ESTIMATE ${String(answer.status)} call=${asked.tool_call_id}`)
      const v = rec(answer.values)
      const data = grpoEstimate({ ...values, prompts: Number(v.prompts) }, { focus: v.focus })
      if (returned.length === 0) return call('return_ui_result', { data, message: 'estimate with the asked setup' })
      return say(`${MARK.estimate} group_size=${values.group_size} prompts=${String(v.prompts)} sde_steps=${values.sde_steps} focus=${String(data.focus)} rollouts=${data.rollouts_per_step} asked=${String(answer.input_id)} call=${asked.tool_call_id} task=${String(last.task_id)}`)
    }
    case 'sweep': {
      if (returned.length === 0) return call('return_ui_result', { data: { points: [{ noise: values.noise ?? null, rollouts: values.prompts * values.group_size }] } }, `${MARK.sweepStarted}: sweeping the noise level from ${String(values.noise)}`)
      await hold(GATES.sweep)
      return say('SWEEP_DONE')
    }
    case 'check': {
      const over = typeof values.kl_beta === 'number' && values.kl_beta > KL_LIMIT
      if (returned.length === 0) {
        return call('return_ui_result', over
          ? { ok: false, message: `KL beta ${values.kl_beta} is over the planner's limit ${KL_LIMIT}`, data: { kl_beta: values.kl_beta, limit: KL_LIMIT } }
          : { ok: true, data: { kl_beta: values.kl_beta ?? null, limit: KL_LIMIT } })
      }
      return say(`${MARK.check} kl_beta=${String(values.kl_beta)} ${over ? 'over the limit' : 'within the limit'}`)
    }
    default:
      return say(`UNKNOWN_ACTION ${action}`)
  }
}

// ---------------------------------------------------------------- scripted:ui-ask (request_input)

/** Asks with request_input; once the call has its result, the answer quotes what came back — the call's id, the
 *  input's id and each value — so the page shows what the model read. Stateless (reads this turn's history). */
function uiAskScript(model: string) {
  return async (messages: ModelMessage[]): Promise<ModelResponse> => {
    const { since } = thisTurn(messages)
    const answer = toolReturns(since).filter((p) => p.tool_name === 'request_input').at(-1)
    if (!answer) return call('request_input', requestInputForm())
    const r = rec(answer.content)
    seen.push({ model, kind: 'ask', tool_call_id: answer.tool_call_id, result: answer.content })
    if (r.status === 'submitted') {
      const v = rec(r.values)
      const methods = Array.isArray(v.methods) ? v.methods.join(',') : String(v.methods)
      return say(`${MARK.ask} submitted call=${answer.tool_call_id} input=${String(r.input_id)} methods=${methods} group_size=${String(v.group_size)} note=${JSON.stringify(v.note)} use_kl=${String(v.use_kl)}`)
    }
    if (r.status === 'dismissed') return say(`${MARK.ask} dismissed call=${answer.tool_call_id} input=${String(r.input_id)}`)
    return say(`${MARK.ask} ${String(r.status)} call=${answer.tool_call_id} ${JSON.stringify(r).slice(0, 400)}`)
  }
}

// ---------------------------------------------------------------- the server

function config(): HarnessConfig {
  return {
    models: [
      new ModelConfig({ id: 'scripted:ui-run', label: 'Scripted UI Run', provider: 'openai', model: 'scripted-ui-run', api_key_env: 'OASIS_UI_E2E_KEY' }),
      new ModelConfig({ id: 'scripted:ui-ask', label: 'Scripted UI Ask', provider: 'openai', model: 'scripted-ui-ask', api_key_env: 'OASIS_UI_E2E_KEY' }),
    ],
    default_model: 'scripted:ui-run', context_window_fallback_tokens: 120_000, protected_paths: ['secrets/**'],
    command_env_passthrough: ['PATH', 'LANG', 'LC_ALL'], checks: [], command_timeout_s: 600, command_output_cap_bytes: 8 * 1024 * 1024,
    // confirmed as on a machine where the person said yes once (the question itself: full-access-ask.e2e.ts)
    full_access_confirmed: true,
  }
}

async function main(): Promise<void> {
  // nothing but the loopback, before anything of the app is made
  installNetworkGuard()
  // the routes name this variable: a fake value makes them "available (env)"; no request ever leaves (scripted)
  process.env.OASIS_UI_E2E_KEY = 'ui-e2e-fake-key'
  const root = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || tmpdir(), 'oasis-ui-e2e-'))
  // the server first (a free port), the app behind a promise: a request before it is made waits for it
  let resolveApp!: (fetch: (req: Request, srv: unknown) => Response | Promise<Response>) => void
  const appFetch = new Promise<(req: Request, srv: unknown) => Response | Promise<Response>>((r) => { resolveApp = r })
  const server = Bun.serve({
    hostname: '127.0.0.1', port: Number(process.env.OASIS_CODE_E2E_PORT || 0), idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (!url.pathname.startsWith('/e2e/')) return (await appFetch)(req, srv)
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response('no', { status: 403 })
      if (url.pathname === '/e2e/seen' && req.method === 'GET') return Response.json(seen)
      if (url.pathname === '/e2e/gate' && req.method === 'POST') {
        const name = url.searchParams.get('name') ?? ''
        const op = url.searchParams.get('op') ?? 'release'
        if (op === 'arm') { armed.add(name); return Response.json({ armed: true }) }
        if (op === 'disarm') { const was = armed.delete(name); return Response.json({ disarmed: was }) }
        const release = waiting.get(name)
        release?.()
        return Response.json({ released: release !== undefined })
      }
      return new Response('not found', { status: 404 })
    },
  })
  const settings = new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port: server.port, session_token: TOKEN })
  const models = { 'scripted:ui-run': scriptedModel(uiRunScript('scripted:ui-run'), 'scripted-ui-run'), 'scripted:ui-ask': scriptedModel(uiAskScript('scripted:ui-ask'), 'scripted-ui-ask') }
  const built = await createApp(settings, config(), { model_overrides: models, probe: false })
  await built.start()
  resolveApp((req, srv) => built.fetch(req, srv))
  console.log(JSON.stringify({ port: server.port, token: TOKEN, data: settings.data_dir, isolation: built.state.isolation.enforcement }))
  const stop = async () => {
    server.stop(true)
    await built.close()
    rmSync(root, { recursive: true, force: true })
    process.exit(0)
  }
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })
}

if (import.meta.main) await main()
