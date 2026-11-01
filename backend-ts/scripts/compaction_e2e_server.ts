/** Real app + scripted model for compaction UI acceptance. No provider calls; the summary waits at a test gate. */
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { ContextKeeper, type ContextAnchor } from '../src/agent/history.ts'
import { basename, join, resolve } from 'node:path'
import { setDefaultAuthDir } from '../src/auth/store.ts'
import { ModelConfig, Settings } from '../src/config.ts'
import { createApp } from '../src/main.ts'
import { isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, userText } from '../src/llm/messages.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { testConfig } from '../tests/harness.ts'
import { installNetworkGuard } from '../tests/network_guard.ts'

const root = process.env.OASIS_CODE_E2E_ROOT
const data = process.env.OASIS_CODE_DATA
if (!root || !basename(root).startsWith('compaction-e2e-') || !data || resolve(data) !== join(resolve(root), 'data')
  || process.env.OASIS_CODE_AUTH_DIR !== data || readdirSync(data).length) throw new Error('Fresh isolated fixture data/auth directory required')
setDefaultAuthDir(data)
installNetworkGuard()
process.env.OASIS_TEST_KEY_A = 'synthetic-only'
const config = testConfig([new ModelConfig({ id: 'scripted:a', label: 'Scripted compaction', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A', context_window: 120_000, max_tokens: 16_000 })])
let release: (() => void) | null = null
let normal = 0
// Unset output would reserve 30k here, making the synthetic 100k count exceed the 90k hard input budget.
const budget = new ContextKeeper({ window: 120_000, output_reserve: 16_000 })
const countedInput = 100_000
assert.ok(budget.threshold < countedInput && countedInput < budget.inputLimit)
let anchor: ContextAnchor | null = null
const model = scriptedModel(async (history, info) => {
  const tail = history.at(-1)!
  const summary = isRequest(tail) && tail.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
  const seam = { instructions: history.findLast(isRequest)?.instructions ?? '', params: info.model_request_parameters }
  const estimate = budget.predict(history, seam).tokens
  // Before compaction the summary still extends the counted prefix. Check that prediction too, without adding
  // the fixed provider frame a second time; after compaction only the fresh working view is estimated.
  const anchored = summary ? new ContextKeeper({ window: budget.window, output_reserve: budget.output_reserve, anchor }).predict(history, seam).tokens : null
  console.log(JSON.stringify({ fixture_request: summary ? 'summary' : 'ordinary', estimate, anchored, output: info.model_settings.max_tokens, threshold: budget.threshold, input_limit: budget.inputLimit }))
  assert.equal(info.model_settings.max_tokens, 16_000)
  assert.ok(estimate <= budget.inputLimit)
  if (summary) {
    assert.ok(anchor && anchored !== null && anchored > budget.threshold && anchored <= budget.inputLimit)
    await new Promise<void>((resolve) => { release = resolve })
    release = null
    return modelResponse([textPart('<summary>The folder was read. Report that the inspection is complete.</summary>')])
  }
  normal++
  if (normal === 1) anchor = { input_tokens: countedInput, messages: history.length }
  return normal === 1
    ? modelResponse([toolCallPart('read_file', { path: '.' }, 'inspect')], { usage: { input_tokens: countedInput, output_tokens: 10 } as never })
    : modelResponse([textPart('Inspection complete.')])
})
const app = await createApp(new Settings({ data_dir: data, host: '127.0.0.1', port: 8399, session_token: 'e2e-token' }), config,
  { probe: false, model_overrides: { 'scripted:a': model } })
try {
  await app.start()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 8399, idleTimeout: 255, fetch: (request, server) => {
    if (new URL(request.url).pathname === '/e2e/compaction-release') {
      if (request.method !== 'POST' || request.headers.get('authorization') !== 'Bearer e2e-token') return new Response('no', { status: 403 })
      const held = release !== null
      release?.()
      return Response.json({ released: held })
    }
    return app.fetch(request, server)
  } })
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    release?.()
    server.stop(true)
    await app.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => { void stop() })
  console.log(JSON.stringify({ ready: true, pid: process.pid, port: server.port }))
} catch (error) { await app.close(); throw error }
