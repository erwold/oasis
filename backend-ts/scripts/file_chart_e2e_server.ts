/** A backend for frontend/e2e/file-chart-live.e2e.ts (a chart read from a file a training script keeps appending to):
 *  the real app (createApp: RunManager, the tools, SQLite, REST, SSE, the built UI) on a fresh data directory, with a
 *  SCRIPTED MODEL in place of a provider. Nothing reaches a cloud: the scripted route is the only model, the global
 *  fetch refuses every host but the loopback, and the data directory is a new temporary folder — never the person's
 *  ~/.oasis-code. The isolation runtime is not probed (`probe: false`): nothing here runs a command.
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

function script(messages: ModelMessage[]) {
  const { words, since } = turnWords(messages)
  const shown = toolReturns(since).filter((p) => p.tool_name === 'present_ui').at(-1)?.content as Record<string, unknown> | undefined
  if (shown) return modelResponse([textPart(`Charted: ${String(shown.status)} ${String(shown.surface_id)} revision ${String(shown.revision)}.`)])
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
  const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.OASIS_CODE_E2E_PORT || 0), idleTimeout: 255, async fetch(req, srv) { return (await appFetch)(req, srv) } })
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
