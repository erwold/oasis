/** A backend for frontend/e2e/atelier-app.e2e.ts and frontend/scripts/capture-atelier-app.ts: the real app (createApp:
 *  RunManager, the tools, SQLite, REST, SSE, the built UI from frontend/dist) on a fresh temporary data directory, with
 *  SCRIPTED MODELS in place of providers, so the normal page (no demo query, no in-memory adapter) draws a live
 *  native surface and a few agents of a session the way it draws real ones.
 *
 *  What the scripted models do — nothing of it is a measurement of anything:
 *    scripted:trainer  a person's turn: present_ui of one native surface (`training_metrics`, a row of four cards, each
 *                      a metric and a series chart over a SIMULATED training run), then the same surface again every
 *                      TICK_MS with the run TICK_STEPS steps further — a new revision of the same block each time,
 *                      through the real tool — for TICKS revisions (OASIS_ATELIER_TICKS, default and at most 59: the
 *                      product lets a run write 60 revisions, MAX_UI_REVISIONS_PER_RUN, and the notes are one), then an
 *                      answer. About 30 s of live updates at 2 a second.
 *                      Words holding "#short" make it 6 revisions (the e2e). Its second publication is the run's
 *                      notes (`run_notes`), an html surface of plain elements on the frame's base stylesheet.
 *    scripted:eval, scripted:data, scripted:report  a separate task's turn: wait (the person's words may say
 *                      "hold <seconds>s"; else 150 s, 110 s, 3 s), then answer — a run that stands running, then done.
 *  Nothing reaches a cloud: the scripted routes are the only models, the global fetch refuses every host but the
 *  loopback, and the data directory is a new temporary folder — never the person's ~/.oasis-code. The isolation
 *  runtime is not probed (`probe: false`: the report says `unavailable`; nothing here runs a command).
 *
 *  It listens on 127.0.0.1 at OASIS_CODE_E2E_PORT (else a free port) and prints one JSON line first on stdout:
 *  { port, token, data, isolation }.
 *
 *      OASIS_CODE_E2E_PORT=8399 bun run scripts/atelier_e2e_server.ts */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelConfig, Settings, type HarnessConfig } from '../src/config.ts'
import { isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, toolReturns, type ModelMessage, type ModelRequest, type ModelResponse } from '../src/llm/messages.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { createApp } from '../src/main.ts'
import { installNetworkGuard } from '../tests/network_guard.ts'

const TOKEN = 'atelier-e2e-token'
const TICK_MS = 500
const TICK_STEPS = 40
// a run writes at most MAX_UI_REVISIONS_PER_RUN (60) revisions in all (ui_surfaces.ts): the notes take one, the metrics the rest
const TICKS = Math.min(59, Number(process.env.OASIS_ATELIER_TICKS || 59))
const WINDOW = 4_000
const MAX_POINTS = 240

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const say = (text: string): ModelResponse => modelResponse([textPart(text)])

/** This turn's words (the last request with the prompt) and what came after it. */
function thisTurn(messages: ModelMessage[]): { words: string; since: ModelMessage[] } {
  const at = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
  if (at < 0) return { words: '', since: messages }
  const request = messages[at] as ModelRequest
  const words = request.parts.filter(isUserPrompt).map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n'))).join('\n')
  const after = request.parts.findLastIndex(isUserPrompt) + 1
  return { words, since: [{ ...request, parts: request.parts.slice(after) }, ...messages.slice(at + 1)] }
}

// ---------------------------------------------------------------- the simulated run (deterministic)

function noise(seed: number, i: number): number {
  let x = (seed * 374761393 + i * 668265263) | 0
  x = (x ^ (x >>> 13)) * 1274126177
  return (((x ^ (x >>> 16)) >>> 0) / 4294967295) * 2 - 1
}
const r3 = (v: number) => Math.round(v * 1000) / 1000
const at = (s: number) => ({
  train: 0.62 + 1.9 * Math.exp(-s / 2600) + 0.05 * noise(1, s),
  val: 0.66 + 1.85 * Math.exp(-s / 2700) + 0.012 * noise(2, s),
  reward: 0.18 + 0.64 * (1 - Math.exp(-s / 3200)) + 0.03 * noise(3, s),
  acc: 0.31 + 0.5 * (1 - Math.exp(-s / 3600)) + 0.006 * noise(4, s),
  tok: 182 + 9 * noise(5, s) + (s % 1000 < 40 ? -24 : 0),
  grad: 0.9 + 0.5 * Math.exp(-s / 1800) + 0.35 * Math.abs(noise(6, s)),
})

/** One series over the window, every `stride` steps, at most MAX_POINTS points. */
function line(id: string, label: string, step: number, every: number, read: (s: number) => number, dashed = false) {
  const from = Math.max(0, step - WINDOW)
  const stride = Math.max(every, Math.ceil((step - from) / MAX_POINTS / every) * every)
  const data: { x: number; value: number }[] = []
  for (let s = Math.ceil(from / stride) * stride; s <= step; s += stride) data.push({ x: s, value: r3(read(s)) })
  return { id, label, ...(dashed ? { line_style: 'dashed' } : {}), data }
}

export function metricsArgs(step: number): Record<string, unknown> {
  const now = at(step)
  const ckpt = Math.floor(step / 500) * 500
  const card = (id: string, metric: Record<string, unknown>, series: unknown[]) => ({
    [id]: { type: 'card', children: [`${id}_m`, `${id}_c`] },
    [`${id}_m`]: { type: 'metric', props: metric },
    [`${id}_c`]: { type: 'chart', props: { kind: 'line', x_axis: 'number', series } },
  })
  return {
    surface_id: 'training_metrics', title: 'Training run · simulated', kind: 'native', root: 'root',
    fallback: `Simulated training run at step ${step}: train loss ${r3(now.train)}, reward ${r3(now.reward)}.`,
    elements: {
      root: { type: 'row', children: ['loss', 'quality', 'speed', 'grad'] },
      ...card('loss', { label: 'Loss · train / val', value: r3(now.train), unit: `val ${r3(at(ckpt).val)}` },
        [line('train', 'train', step, 20, (s) => at(s).train), line('val', 'val · per ckpt', step, 500, (s) => at(s).val, true)]),
      ...card('quality', { label: 'Reward · accuracy', value: r3(now.reward), unit: `acc ${(at(ckpt).acc * 100).toFixed(1)}%` },
        [line('reward', 'reward', step, 20, (s) => at(s).reward), line('acc', 'accuracy · per ckpt', step, 500, (s) => at(s).acc, true)]),
      ...card('speed', { label: 'Throughput', value: Math.round(now.tok), unit: 'k tok/s' }, [line('tok', 'k tok/s', step, 20, (s) => at(s).tok)]),
      ...card('grad', { label: 'Grad norm', value: r3(now.grad), unit: 'clip 5.0' }, [line('grad', 'grad norm · max', step, 20, (s) => at(s).grad)]),
    },
  }
}

/** The run's notes as an html surface: plain elements only, drawn by the frame's base stylesheet on the host's theme. */
const NOTES_ARGS = {
  surface_id: 'run_notes', title: 'Run notes · simulated', kind: 'html',
  fallback: 'Simulated run notes: checkpoints every 500 steps, eval on 64 prompts.',
  html: `<main style="display:grid;gap:8px;padding:10px 12px">
<h3 style="margin:0">Checkpoints</h3>
<table><thead><tr><th>Step</th><th>Val loss</th><th>Acc %</th></tr></thead>
<tbody><tr><td>2,000</td><td>1.249</td><td>51.8</td></tr><tr><td>1,500</td><td>1.361</td><td>48.0</td></tr><tr><td>1,000</td><td>1.512</td><td>43.6</td></tr></tbody></table>
<div style="display:flex;gap:8px;align-items:center"><input id="step" type="text" value="2,000" aria-label="Step" size="6"> <button type="button" id="cmp">Compare</button><label><input type="checkbox" checked> val only</label></div>
</main>`,
}

/** The trainer: present the surface, then again every tick with the run further on, then answer. */
function trainerScript() {
  return async (messages: ModelMessage[]): Promise<ModelResponse> => {
    const { words, since } = thisTurn(messages)
    const ticks = words.includes('#short') ? 6 : TICKS
    const calls = toolReturns(since).filter((p) => p.tool_name === 'present_ui').length
    // the first publication of the metrics, then the run's notes (an html surface), then the metrics again and again
    if (calls === 1) return modelResponse([toolCallPart('present_ui', NOTES_ARGS, '')])
    const shown = calls === 0 ? 0 : calls - 1
    if (shown >= ticks) return say(`Published ${shown} revisions of training_metrics (simulated).`)
    if (shown > 0) await sleep(TICK_MS)
    return modelResponse([toolCallPart('present_ui', metricsArgs(2_000 + shown * TICK_STEPS), '')])
  }
}

/** A helper agent: wait as long as its words say ("hold <n>s"), else its own time, then answer. */
function helperScript(name: string, seconds: number) {
  return async (messages: ModelMessage[]): Promise<ModelResponse> => {
    const { words } = thisTurn(messages)
    const hold = Number(/hold (\d+)s/.exec(words)?.[1] ?? seconds)
    await sleep(hold * 1000)
    return say(`${name}: done after ${hold} s (scripted).`)
  }
}

// ---------------------------------------------------------------- the server

const HELPERS = [['scripted:eval', 'Checkpoint eval', 150], ['scripted:data', 'Data audit', 110], ['scripted:report', 'Run report', 3]] as const

function config(): HarnessConfig {
  return {
    models: [
      new ModelConfig({ id: 'scripted:trainer', label: 'Scripted Trainer', provider: 'openai', model: 'scripted-trainer', api_key_env: 'OASIS_ATELIER_E2E_KEY' }),
      ...HELPERS.map(([id, label]) => new ModelConfig({ id, label, provider: 'openai', model: id.replace(':', '-'), api_key_env: 'OASIS_ATELIER_E2E_KEY' })),
    ],
    default_model: 'scripted:trainer', context_window_fallback_tokens: 120_000, protected_paths: ['secrets/**'],
    command_env_passthrough: ['PATH', 'LANG', 'LC_ALL'], checks: [], command_timeout_s: 600, command_output_cap_bytes: 8 * 1024 * 1024,
    full_access_confirmed: true,
  }
}

async function main(): Promise<void> {
  installNetworkGuard()
  process.env.OASIS_ATELIER_E2E_KEY = 'atelier-e2e-fake-key'
  const root = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || tmpdir(), 'oasis-atelier-e2e-'))
  let resolveApp!: (fetch: (req: Request, srv: unknown) => Response | Promise<Response>) => void
  const appFetch = new Promise<(req: Request, srv: unknown) => Response | Promise<Response>>((r) => { resolveApp = r })
  const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.OASIS_CODE_E2E_PORT || 0), idleTimeout: 255, async fetch(req, srv) { return (await appFetch)(req, srv) } })
  const settings = new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port: server.port, session_token: TOKEN })
  const models: Record<string, ReturnType<typeof scriptedModel>> = { 'scripted:trainer': scriptedModel(trainerScript(), 'scripted-trainer') }
  for (const [id, label, seconds] of HELPERS) models[id] = scriptedModel(helperScript(label, seconds), id.replace(':', '-'))
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

if (import.meta.main) void main()
