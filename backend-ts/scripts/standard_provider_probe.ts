/** Opt-in, paid standard-provider smoke probe. No credentials are read on import or dry-run.
 * After saving keys in Settings > Accounts, run from backend-ts:
 *   bun run scripts/standard_provider_probe.ts             # dry-run, no network or credential access
 *   bun run scripts/standard_provider_probe.ts --live      # five routes, at most two requests each
 * Uses the normal credential helper inside buildModel, never prints headers, keys, raw errors or reasoning.
 * All current tool definitions are sent unchanged. Only a read_file of this probe's temporary fixture is
 * executed (a bounded local file read); any other tool request fails closed. No app/database is started.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgent } from '../src/agent/agent.ts'
import { ModelHTTPError, ModelAPIError, TransportError, PROVIDER_CONTEXT_WORDS, PROVIDER_QUOTA_WORDS, PROVIDER_MODEL_GONE_WORDS } from '../src/llm/model.ts'
import { ModelConfig, STANDARD_CN_MODELS } from '../src/config.ts'
import { answerText, isToolCall, modelRequest, toolReturn, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import type { Model, ModelRequestParameters, ToolDefinition } from '../src/llm/model.ts'
import { buildModel } from '../src/llm/providers.ts'
import { UsageMeter, toolSchemaFingerprint } from '../src/llm/usage.ts'

export function probeTools(): ToolDefinition[] {
  return buildAgent().toolDefinitions()
}

export function safeProbeFailure(error: unknown) {
  const status = error instanceof ModelHTTPError && Number.isInteger(error.status_code) ? error.status_code : null
  const category = error instanceof ModelHTTPError
    ? PROVIDER_CONTEXT_WORDS.test(error.message) ? 'context_overflow'
      : PROVIDER_QUOTA_WORDS.test(error.message) ? 'quota'
      : PROVIDER_MODEL_GONE_WORDS.test(error.message) ? 'model_unavailable'
      : status === 401 || status === 403 ? 'access' : status === 429 ? 'rate_limit' : 'http'
    : error instanceof TransportError ? 'transport' : error instanceof ModelAPIError ? 'protocol' : 'probe_contract'
  return { status, category }
}

async function probeStream(model: Model, messages: ModelMessage[], settings: { max_tokens: number }, params: ModelRequestParameters, signal: AbortSignal) {
  const stream = await model.requestStream(messages, settings, params, { signal })
  const events = { total: 0, text_delta: 0, thinking_delta: 0, tool_delta: 0 }
  for await (const event of stream.events()) {
    events.total++
    if (event.type === 'part_delta') {
      if (event.delta.part_kind === 'text') events.text_delta++
      else if (event.delta.part_kind === 'thinking') events.thinking_delta++
      else if (event.delta.part_kind === 'tool-call') events.tool_delta++
    }
  }
  return { response: stream.get(), events }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let live = false, routeId: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') live = true
    else if (argv[i] === '--dry-run') { /* default; never reads a credential */ }
    else if (argv[i] === '--route' && argv[i + 1]) routeId = argv[++i]!
    else throw new Error('Use --live or --dry-run, optionally --route ID')
  }
  if (argv.includes('--dry-run') && live) throw new Error('Choose --live or --dry-run')
  if (routeId !== null && !STANDARD_CN_MODELS.some((r) => r.id === routeId)) throw new Error('Unknown route')
  const params: ModelRequestParameters = { function_tools: probeTools(), allow_text_output: true, thinking: 'low' }
  const routes = STANDARD_CN_MODELS.filter((r) => routeId === null || r.id === routeId).map((raw) => new ModelConfig(raw as never))
  if (!live) {
    console.log(JSON.stringify({ live: false, routes: routes.map((r) => r.id), tools: params.function_tools.length, tool_names: params.function_tools.map((t) => t.name), tool_schema_sha256: toolSchemaFingerprint(params) }))
    return 0
  }
  const folder = mkdtempSync(join(tmpdir(), 'oasis-provider-probe-'))
  const path = join(folder, 'probe.txt')
  const marker = `probe-${crypto.randomUUID()}`
  writeFileSync(path, marker, { mode: 0o600 })
  let failed = false
  try {
    for (const cfg of routes) {
      let stage = 'prepare'
      try {
        const records: { cost_usd: number | null; cost_cny?: number | null; cost_status: string }[] = []
        const model = new UsageMeter(buildModel(cfg, { maxRetries: 0 }), cfg, 'probe', (r) => records.push(r), () => {})
        const settings = { max_tokens: 4096 }
        const signal = AbortSignal.timeout(120_000)
        const history: ModelMessage[] = [modelRequest([userPrompt(`Call read_file exactly once with path ${JSON.stringify(path)}. No other tool. After its result, reply with the file's exact text; do not guess it.`)])]
        stage = 'first_request'
        const firstStream = await probeStream(model, history, settings, params, signal)
        const first = firstStream.response
        stage = 'tool_validation'
        const calls = first.parts.filter(isToolCall)
        if (calls.length !== 1 || calls[0]!.tool_name !== 'read_file') throw new Error('tool-call contract not met')
        const call = calls[0]!
        const args = typeof call.args === 'string' ? JSON.parse(call.args) : call.args
        if (args?.path !== path) throw new Error('fixture boundary not met')
        const content = readFileSync(path, 'utf8')
        history.push(first, modelRequest([toolReturn('read_file', { status: 'ok', path, content }, call.tool_call_id)]))
        stage = 'continuation_request'
        const secondStream = await probeStream(model, history, settings, params, signal)
        stage = 'continuation_validation'
        const second = secondStream.response
        if (second.parts.some(isToolCall) || !answerText(second.parts).includes(marker)) throw new Error('tool return not acknowledged')
        console.log(JSON.stringify({ route: cfg.id, ok: true, provider_models: [first.model_name, second.model_name],
          usage: [first.usage, second.usage], stream_events: [firstStream.events, secondStream.events],
          costs: records.map((r) => ({ cost_usd: r.cost_usd, cost_cny: r.cost_cny, cost_status: r.cost_status })), totals: model.totalsWithTokens(), tools: params.function_tools.length, tool_names: params.function_tools.map((t) => t.name), tool_schema_sha256: toolSchemaFingerprint(params) }))
      } catch (error) {
        // Deliberately do not stringify an error: upstream errors may echo credentials or request content.
        failed = true
        console.log(JSON.stringify({ route: cfg.id, ok: false, stage, ...safeProbeFailure(error) }))
      }
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
  return failed ? 1 : 0
}

if (import.meta.main) main().then((code) => { process.exitCode = code }).catch(() => { console.error('probe failed'); process.exitCode = 1 })
