/** A backend for frontend/e2e/file-chart-live.e2e.ts (a chart read from a file a training script keeps appending to):
 *  the real app (createApp: RunManager, the tools, SQLite, REST, SSE, the built UI) on a fresh data directory, with a
 *  SCRIPTED MODEL in place of a provider. Nothing reaches a cloud: the scripted route is the only model, the global
 *  fetch refuses every host but the loopback, and the data directory is a new temporary folder — never the person's
 *  ~/.oasis-code. The isolation runtime is not probed (`probe: false`); progress demos execute only their own synthetic Python writer.
 *
 *  The scripted model, on a turn whose words name a path (`chart <path>`), calls present_ui once — a native surface whose
 *  chart reads that path as JSON Lines (x `step`, series `loss` solid and `val_loss` dashed) — through the real loop and
 *  tools, then answers in words. It never calls present_ui again: every later point the chart shows is read by the
 *  app from the file.
 *
 *  It listens on 127.0.0.1 at OASIS_CODE_E2E_PORT (else a free port) and prints one JSON line first on stdout:
 *  { port, token, data }. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelConfig, Settings, type HarnessConfig } from '../src/config.ts'
import { isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, toolReturns, type ModelMessage, type ModelRequest } from '../src/llm/messages.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { createApp } from '../src/main.ts'
import { installNetworkGuard } from '../tests/network_guard.ts'

const TOKEN = 'file-chart-e2e-token'

/** The spec the scripted model presents: the chart of a training log (two series), and nothing of its points. */
export function trainingChartSpec(path: string): Record<string, unknown> {
  return {
    version: 1, surface_id: 'training', title: 'Training run', kind: 'native',
    fallback: `Loss and validation loss by step, read from ${path} while the surface is shown.`,
    root: 'root',
    elements: {
      root: { type: 'stack', children: ['loss'] },
      loss: {
        type: 'chart',
        props: {
          kind: 'line', x_axis: 'number', label: 'Loss', y_label: 'loss',
          source: { path, format: 'jsonl', x: 'step', series: [{ id: 'loss', label: 'train loss', column: 'loss' }, { id: 'val', label: 'val loss', column: 'val_loss', line_style: 'dashed' }] },
        },
      },
    },
  }
}

function turnWords(messages: ModelMessage[]): { words: string; since: ModelMessage[] } {
  const at = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
  if (at < 0) return { words: '', since: messages }
  const request = messages[at] as ModelRequest
  const words = request.parts.filter(isUserPrompt).map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n'))).join('\n')
  const after = request.parts.findLastIndex(isUserPrompt) + 1
  return { words, since: [{ ...request, parts: request.parts.slice(after) }, ...messages.slice(at + 1)] }
}

let modelCalls = 0
const TRAINING_WRITER = `import json, math, os, pathlib, sys, time
path, mode = sys.argv[1:]
pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
print('OWNED_WRITER_PID=' + str(os.getpid()), flush=True)
steps = 70 if mode == 'train' else 5
with open(path, 'w') as f:
    for step in range(steps + 1):
        r = dict(step=step, done=step, total=steps, rate=0.5, eta=(steps-step)*2, status='running', log=f'step {step}/{steps}: processed batch', loss=round(2.5*math.exp(-step/20)+0.1, 5))
        f.write(json.dumps(r)+'\\n'); f.flush()
        time.sleep(2)
    if mode == 'fail':
        print('simulated crash before terminal record', file=sys.stderr, flush=True)
        sys.exit(7)
    f.write(json.dumps(dict(status='succeeded', log='checkpoint saved; training complete'))+'\\n'); f.flush()
`
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
function script(messages: ModelMessage[]) {
  modelCalls += 1
  const { words, since } = turnWords(messages)
  const shown = toolReturns(since).filter((p) => p.tool_name === 'present_ui').at(-1)?.content as Record<string, unknown> | undefined
  if (shown) return modelResponse([textPart(`Charted: ${String(shown.status)} ${String(shown.surface_id)} revision ${String(shown.revision)}.`)])
  if (/surface (native|html)/.test(words)) {
    const html = words.includes('surface html')
    return modelResponse([toolCallPart('present_ui', html ? {
      version: 1, surface_id: 'visual', title: 'HTML workspace', fallback: 'A small interactive HTML surface.', kind: 'html',
      html: '<main><h3>Batch review</h3><p>12 images ready for review.</p><button onclick="this.textContent=\'Reviewed\'">Mark reviewed</button></main>',
    } : {
      version: 1, surface_id: 'visual', title: 'Native workspace', fallback: 'Loss and batch controls.', kind: 'native', root: 'r',
      elements: {
        r: { type: 'stack', children: ['chart', 'size'] },
        chart: { type: 'chart', props: { kind: 'line', label: 'Loss', x_axis: 'number', series: [{ id: 'loss', label: 'Loss', data: [{ x: 1, value: 1.2 }, { x: 2, value: 0.8 }, { x: 3, value: 0.4 }] }] } },
        size: { type: 'input', props: { label: 'Batch size', key: 'size', inputType: 'number' } },
      }, initial_state: { size: 16 },
    }, '')])
  }
  const progress = /progress (train|fail) (\S+)/.exec(words)
  if (progress) {
    const mode = progress[1]!, path = progress[2]!
    const command = toolReturns(since).filter((p) => p.tool_name === 'bash').at(-1)?.content as Record<string, unknown> | undefined
    if (!command) return modelResponse([toolCallPart('bash', { command: `python3 -u -c ${quote(TRAINING_WRITER)} ${quote(path)} ${quote(mode)}`, wait_s: 1, timeout_s: 200 }, '')])
    if (!command.execution_id) return modelResponse([textPart(`Command failed: ${JSON.stringify(command)}`)])
    const mapping = { completed: 'done', total: 'total', rate: 'rate', eta: 'eta', status: 'status', log: 'log', execution_id: command.execution_id }
    const spec = trainingChartSpec(path) as any
    spec.fallback = mode === 'train' ? 'Training progress and loss; execution-bound completion.' : 'Batch image conversion progress; execution-bound result.'
    spec.title = mode === 'train' ? 'Training · 70 steps' : 'Image batch · crash demo'
    if (mode === 'train') { spec.elements.loss.props.source.progress = mapping; spec.elements.loss.props.source.series = spec.elements.loss.props.source.series.slice(0, 1) }
    else spec.elements.loss = { type: 'progress', props: { label: 'Converting images', source: { path, format: 'jsonl', progress: mapping } } }
    return modelResponse([toolCallPart('present_ui', spec, '')])
  }
  const path = /chart (\S+)/.exec(words)?.[1]
  if (!path) return modelResponse([textPart('Name a file to chart.')])
  return modelResponse([toolCallPart('present_ui', trainingChartSpec(path), '')])
}

function config(): HarnessConfig {
  return {
    models: [new ModelConfig({ id: 'scripted:file-chart', label: 'Scripted File Chart', provider: 'openai', model: 'scripted-file-chart', api_key_env: 'OASIS_FILE_CHART_E2E_KEY' })],
    default_model: 'scripted:file-chart', context_window_fallback_tokens: 120_000, protected_paths: ['secrets/**'],
    command_env_passthrough: ['PATH', 'LANG', 'LC_ALL'], checks: [], command_timeout_s: 600, command_output_cap_bytes: 8 * 1024 * 1024,
    full_access_confirmed: true,
  }
}

async function main(): Promise<void> {
  installNetworkGuard()
  process.env.OASIS_FILE_CHART_E2E_KEY = 'file-chart-e2e-fake-key'
  const root = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || tmpdir(), 'oasis-file-chart-e2e-'))
  let resolveApp!: (fetch: (req: Request, srv: unknown) => Response | Promise<Response>) => void
  const appFetch = new Promise<(req: Request, srv: unknown) => Response | Promise<Response>>((r) => { resolveApp = r })
  const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.OASIS_CODE_E2E_PORT || 0), idleTimeout: 255, async fetch(req, srv) { if (new URL(req.url).pathname === '/__test/model-calls') return Response.json({ modelCalls }); return (await appFetch)(req, srv) } })
  const settings = new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port: server.port, session_token: TOKEN })
  const built = await createApp(settings, config(), { model_overrides: { 'scripted:file-chart': scriptedModel(script, 'scripted-file-chart') }, probe: false })
  await built.start()
  resolveApp((req, srv) => built.fetch(req, srv))
  console.log(JSON.stringify({ port: server.port, token: TOKEN, data: settings.data_dir }))
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
