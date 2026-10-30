/** The standing check that the prompt cache is read: three small requests to one route — a run of two (a tool
 *  call, then the answer) and one more that continues it — and the provider's own usage figures for each. On a
 *  route that caches, the first request writes the prefix and every later one reads it (`cache_read` close to the
 *  request before it). A route that reports no reads on a byte-identical prefix has a silent invalidator: diff the
 *  bodies — or its requests are not routed to the machine that holds the cache (the Codex route, by its thread
 *  headers). A read far smaller than the request before is not the conversation's: the start every conversation
 *  shares (the tools) is hot for everyone. Spends about three times the prefix (a few thousand tokens each); nothing else.
 *
 *    bun run cache-probe <route id> [5m|1h]
 *
 *  The route is one of the configured ones (`bun run cache-probe anthropic:claude-opus-5-5`); the optional TTL
 *  overrides the route's `cache_ttl` for this probe only. */

import { INSTRUCTIONS } from '../src/agent/instructions.ts'
import { Agent, type Tool } from '../src/agent/loop.ts'
import { getSettings } from '../src/config.ts'
import { findModel } from '../src/llm/catalog.ts'
import { modelSettings } from '../src/agent/runner.ts'
import type { ModelMessage } from '../src/llm/messages.ts'
import { buildModel } from '../src/llm/providers.ts'

// enough fixed text that the prefix is over every model's cacheable minimum, whatever the tools weigh
const NOTES = ['The project keeps its notes in NOTES.md; each entry names the date, the decision and the reason.',
  'Commands run in the working folder; results that matter are written to files only when asked.',
  'A check that did not run is not a passing check; say what was not checked and why.']
  .map((line, i) => `${i + 1}. ${line}`).join('\n')
const FILLER = Array.from({ length: 40 }, (_, i) => `Rule ${i + 1}: keep the answer short, name the file when one is changed, and state what remains unresolved (${i + 1}).`).join('\n')

// how much of the request before a later request must read from the cache to count as reading the conversation
const READ_SHARE = 0.5

const echo: Tool<null> = {
  name: 'echo', description: 'Echo a word back. Use it once when asked to.',
  parameters_json_schema: { type: 'object', properties: { word: { type: 'string', description: 'the word to echo' } }, required: ['word'] },
  validate: (args) => (typeof (args as { word?: unknown })?.word === 'string' ? { value: args } : { error: 'word must be a string' }),
  fn: (_ctx, args) => ({ echoed: (args as { word: string }).word }),
}

async function main(argv: string[]): Promise<number> {
  const routeId = argv[0]
  const ttl = argv[1] as '5m' | '1h' | undefined
  if (!routeId) { console.error('usage: bun run cache-probe <route id> [5m|1h]'); return 2 }
  if (ttl !== undefined && ttl !== '5m' && ttl !== '1h') { console.error('the TTL is 5m or 1h'); return 2 }
  const config = getSettings().load()
  const cfg = findModel(config, routeId)
  if (cfg === null) { console.error(`unknown route ${routeId}; routes: ${config.models.map((m) => m.id).join(', ')}`); return 2 }
  const model = buildModel(cfg, { maxRetries: 0 })
  const settings = { ...modelSettings(cfg, null, 'oasis:cache-probe'), max_tokens: 256, ...(ttl ? { cache_ttl: ttl } : {}) }
  const agent = new Agent<null>({ instructions: `${INSTRUCTIONS}\n\nProject notes:\n${NOTES}\n\n${FILLER}`, tools: [echo] })
  const rows: Record<string, unknown>[] = []
  const observe = (label: string, messages: ModelMessage[]) => {
    for (const m of messages) {
      if (m.kind !== 'response' || !m.usage) continue
      const u = m.usage
      if (rows.some((r) => r.id === m.provider_response_id)) continue
      rows.push({ request: label, id: m.provider_response_id, input_total: u.input_tokens, cache_read: u.cache_read_tokens, cache_write: u.cache_write_tokens, output: u.output_tokens, model: m.model_name })
    }
  }
  try {
    let history: ModelMessage[] = []
    for await (const event of agent.runStreamEvents({ prompt: "Use the echo tool once with the word 'cache', then answer with the single word OK.", deps: null, model, modelSettings: settings })) {
      if (event.type === 'result') { history = event.result.allMessages(); observe('run 1', history) }
    }
    for await (const event of agent.runStreamEvents({ prompt: 'Answer with the single word OK.', deps: null, model, modelSettings: settings, messageHistory: history })) {
      if (event.type === 'result') observe('run 2 (continues run 1)', event.result.allMessages())
    }
  } finally {
    await model.close?.()
  }
  console.log(JSON.stringify({ route: cfg.id, model: cfg.model, ttl: settings.cache_ttl ?? '5m', requests: rows }, null, 2))
  // the conversation's own prefix was read when the read covers most of the request before (caches count in blocks)
  const read = rows.length > 1 && rows.slice(1).every((r, i) => Number(r.cache_read) >= READ_SHARE * Number(rows[i]!.input_total))
  console.log(read ? 'cache: read on every request after the first' : 'cache: NOT read on some later request — a silent invalidator, requests routed apart, or the prefix is under the cacheable minimum')
  return read ? 0 : 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
