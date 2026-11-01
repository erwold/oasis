/** The working context: the record is only appended to and the model receives it from its last compaction on;
 *  a compaction is one request the model's own summary opens, made only when the next request is predicted to
 *  come close to the route's window — the prediction anchored on the provider's count of the last request, the
 *  summary asked from the very context it stands for (with the pending tail's results left out only when they
 *  would not fit), the record never rewritten; the persisted form round-trips byte for byte. */

import { expect, test } from 'bun:test'
import { rebuildTranscript } from '../src/agent/transcript.ts'
import { compactionThreshold, CONTEXT_MARGIN, countTokens, estimateMessages, resolveWindow, WINDOW_SHARE, wireText } from '../src/agent/context.ts'
import { closeDanglingToolCalls } from '../src/agent/runner.ts'
import {
  compactionCount, compactionIndex, ContextKeeper, ContextView, historyMetrics, isCompaction, outputReserve, summaryOf, workingView,
  type CompactionReport, type RequestSeam,
} from '../src/agent/history.ts'
import { DEFAULT_MODELS, ModelConfig, ModelConfigSchema } from '../src/config.ts'
import { imagePiece } from '../src/llm/images.ts'
import {
  dumpJson, isRequest, isText, isToolReturn, isUserPrompt, loadJson, modelRequest, modelResponse, textPart, thinkingPart, toolCallPart, toolReturn,
  userPrompt, userText, type ModelMessage, type ModelRequest,
} from '../src/llm/messages.ts'
import type { ModelRequestParameters } from '../src/llm/model.ts'
import { scriptedModel, stampedModel } from '../src/llm/scripted.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'

const PARAMS: ModelRequestParameters = { function_tools: [{ name: 'bash', description: 'run', parameters_json_schema: { type: 'object', properties: { command: { type: 'string' } } } }], allow_text_output: true, thinking: null }
const INSTRUCTIONS = 'You are the agent under test.'
const LONG = 'the quick brown fox jumps over the lazy dog '.repeat(40)

function block(i: number, content: unknown = { status: 'ok', exit_code: 0, execution_id: `x_${i.toString(16).padStart(12, '0')}`, stdout: LONG }): ModelMessage[] {
  return [
    modelResponse([thinkingPart('hm', { signature: `sig-${i}`, provider_name: 'anthropic' }), toolCallPart('bash', { command: `make step_${i}` }, `tc_${i}`)], { provider_name: 'anthropic' }),
    modelRequest([toolReturn('bash', content, `tc_${i}`)], INSTRUCTIONS),
  ]
}

function history(n = 6): ModelMessage[] {
  const out: ModelMessage[] = [modelRequest([userPrompt('build it')], INSTRUCTIONS)]
  for (let i = 0; i < n; i += 1) out.push(...block(i))
  return out
}

/** A model that writes a summary when asked for one (the compaction prompt in the last user part), else a word. */
function summarizer(seen: ModelMessage[][] = []) {
  return scriptedModel((messages) => {
    seen.push(messages)
    const last = messages[messages.length - 1]!
    const asked = isRequest(last) && last.parts.some((p) => isUserPrompt(p) && userText(p) === PROMPT_TEXT['compaction.request'])
    if (asked) return modelResponse([textPart(`Before the summary.\n<summary>Steps 0-5 ran make; execution ids kept: x_000000000000. Nothing failed.</summary>`)])
    return modelResponse([textPart('ok')])
  }, 'summarizer')
}

const seam = (model: ReturnType<typeof scriptedModel>, observed: RequestSeam['observed'] = null): RequestSeam => ({ model, settings: { max_tokens: 1000 }, params: PARAMS, instructions: INSTRUCTIONS, observed })

test('the working view is the record from its last compaction on; the record itself is never rewritten', () => {
  const plain = history(3)
  expect(workingView(plain)).toBe(plain)
  expect(compactionIndex(plain)).toBe(-1)
  const marker: ModelRequest = { ...modelRequest([userPrompt('App note: summary one')], INSTRUCTIONS), compaction: { covers: plain.length, tokens_before: 1, summary_input_tokens: 1, model: 'm', at: 't' } }
  const once = [...plain, marker, ...block(10)]
  expect(isCompaction(marker)).toBe(true)
  expect(compactionIndex(once)).toBe(plain.length)
  expect(workingView(once)).toEqual([marker, ...once.slice(plain.length + 1)])
  expect(workingView(once)[0]).toBe(marker)                                            // the record's own objects
  const again: ModelRequest = { ...modelRequest([userPrompt('App note: summary two')], INSTRUCTIONS), compaction: { covers: once.length, tokens_before: 1, summary_input_tokens: 1, model: 'm', at: 't' } }
  const twice = [...once, again, ...block(11)]
  expect(workingView(twice)).toEqual([again, ...twice.slice(once.length + 1)])
  expect(compactionCount(twice)).toBe(2)
  const metrics = historyMetrics(twice, dumpJson(twice))
  expect(metrics.history_compactions).toBe(2)
  expect(metrics.history_wire_bytes!).toBeLessThan(metrics.history_content_bytes!)
  expect(metrics.history_messages).toBe(twice.length)
})

test('the window follows the override, then the route, else the assumed fallback; the threshold keeps the output and a margin free', () => {
  const cfg = new ModelConfig({ id: 'r:x', provider: 'openai', model: 'x', context_window: 272_000, window_source: 'the docs' })
  const bare = new ModelConfig({ id: 'r:y', provider: 'openai', model: 'y' })
  const saved = process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS
  delete process.env['OASIS_CODE_CONTEXT_WINDOW_TOKENS' as string]
  try {
    expect(resolveWindow(cfg, 200_000)).toEqual({ window: 272_000, source: 'configured (the docs)', known: true })
    const assumed = resolveWindow(bare, 200_000)
    expect(assumed.window).toBe(200_000)
    expect(assumed.known).toBe(false)
    expect(assumed.source).toContain('assumed 200,000 tokens')
    process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = '123000'
    expect(resolveWindow(cfg, 200_000)).toEqual({ window: 123_000, source: 'OASIS_CODE_CONTEXT_WINDOW_TOKENS', known: true })
  } finally {
    if (saved === undefined) delete process.env['OASIS_CODE_CONTEXT_WINDOW_TOKENS' as string]
    else process.env.OASIS_CODE_CONTEXT_WINDOW_TOKENS = saved
  }
  expect(compactionThreshold(1_000_000, 16_000)).toBe(Math.min(Math.floor(1_000_000 * WINDOW_SHARE), 1_000_000 - 16_000 - CONTEXT_MARGIN))
  expect(compactionThreshold(1_000_000, 16_000)).toBe(970_000)
  expect(compactionThreshold(200_000, 16_000)).toBe(176_000)
  expect(compactionThreshold(1_000_000, 64_000)).toBe(928_000)
  expect(outputReserve({ max_tokens: 16_000 })).toBe(16_000)
  expect(outputReserve({ max_tokens: 16_000, thinking: 'xhigh' })).toBe(32_768 + 4096)         // the Anthropic mapping raises the cap over the budget
  expect(outputReserve({ max_tokens: 64_000, thinking: 'xhigh' })).toBe(64_000)
})

test('Astra default compacts at 892400, before the observed successful and refused context estimates', () => {
  const astra = new ModelConfig(ModelConfigSchema.parse(DEFAULT_MODELS.find((m) => m.id === 'openai:gpt-6-astra')))
  expect(astra.context_window).toBe(920_000)
  expect(astra.window_source).toContain('919,228')
  expect(astra.window_source).toContain('922,673')
  expect(astra.window_source).toContain('922,698')
  const threshold = compactionThreshold(astra.context_window!, 16_000)
  expect(threshold).toBe(892_400)
  for (const observed of [919_228, 922_673, 922_698]) expect(threshold).toBeLessThan(observed)
})

test('the prediction anchors on the provider\'s count of the last request plus what was appended, else estimates the whole view', () => {
  const keeper = new ContextKeeper({ window: 100_000, output_reserve: 1_000 })
  const messages = history(4)
  const cold = keeper.predict(messages, seam(summarizer()))
  expect(cold.basis).toBe('estimate')
  expect(cold.tokens).toBeGreaterThan(estimateMessages(messages))                           // the instructions, the tools, the factor
  keeper.observe({ input_tokens: 50_000, messages: messages.length })
  const grown = [...messages, ...block(4)]
  const warm = keeper.predict(grown, seam(summarizer()))
  expect(warm.basis).toBe('anchor')
  expect(warm.tokens).toBeGreaterThan(50_000)
  expect(warm.tokens - 50_000).toBeLessThan(estimateMessages(block(4)) * 2)
  // an anchor from before a compaction is no anchor
  const marker: ModelRequest = { ...modelRequest([userPrompt('App note: s')], INSTRUCTIONS), compaction: { covers: grown.length, tokens_before: 1, summary_input_tokens: 1, model: 'm', at: 't' } }
  expect(keeper.predict([...grown, marker], seam(summarizer())).basis).toBe('estimate')
  // a seeded anchor (the previous run's, on the same route) is used from the first prediction
  const seeded = new ContextKeeper({ window: 100_000, output_reserve: 1_000, anchor: { input_tokens: 70_000, messages: messages.length } })
  expect(seeded.predict(grown, seam(summarizer())).basis).toBe('anchor')
  expect(seeded.currentAnchor()).toEqual({ input_tokens: 70_000, messages: messages.length })
})

test('under the threshold the record is returned as it is; over it the model summarizes and one compaction request is appended', async () => {
  const seen: ModelMessage[][] = []
  const model = summarizer(seen)
  const messages = history(6)
  const roomy = new ContextKeeper({ window: 10_000_000, output_reserve: 1_000 })
  const [same, none] = await roomy.maybeCompact(messages, seam(model))
  expect(same).toBe(messages)
  expect(none).toBeNull()
  expect(seen).toHaveLength(0)
  // a window the record does not fit under: the threshold is 20 000 − 500 − 8 000 = 11 500; the provider counted
  // 11 400 for the last request and the two messages since add the rest
  const tight = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  expect(tight.threshold).toBe(11_500)
  const [out, report] = await tight.maybeCompact(messages, seam(model, { input_tokens: 11_400, messages: messages.length - 2 }))
  expect(report!.status).toBe('compacted')
  expect(report!.covers).toBe(messages.length)
  expect(report!.estimate_tokens).toBeGreaterThan(tight.threshold)
  expect(report!.after_tokens!).toBeLessThan(report!.estimate_tokens)
  expect(report!.summary_chars).toBeGreaterThan(0)
  // the summary was asked from the context as it stood, the prompt appended to the pending tail (its results present)
  expect(seen).toHaveLength(1)
  const asked = seen[0]!
  expect(asked.slice(0, -1)).toEqual(messages.slice(0, -1))
  for (let i = 0; i < messages.length - 1; i += 1) expect(asked[i]).toBe(messages[i]!)
  const askedTail = asked[asked.length - 1] as ModelRequest
  expect(askedTail.parts.filter(isToolReturn)).toHaveLength(1)
  expect(userText(askedTail.parts.filter(isUserPrompt).at(-1)!)).toBe(PROMPT_TEXT['compaction.request'])
  // the record: every earlier message the same object, one compaction request at the end
  expect(out).toHaveLength(messages.length + 1)
  for (let i = 0; i < messages.length; i += 1) expect(out[i]).toBe(messages[i]!)
  const marker = out[out.length - 1]!
  expect(isCompaction(marker)).toBe(true)
  if (!isCompaction(marker)) throw new Error('unreachable')
  expect(marker.compaction.covers).toBe(messages.length)
  expect(marker.compaction.tokens_before).toBe(report!.estimate_tokens)
  expect(marker.compaction.model).toBe('summarizer')
  expect(marker.instructions).toBe(INSTRUCTIONS)
  const note = userText(marker.parts[0] as never)
  expect(note).toStartWith('App note: The conversation so far was summarized')
  expect(note).toContain('Steps 0-5 ran make; execution ids kept: x_000000000000. Nothing failed.')
  expect(note).not.toContain('Before the summary.')                                     // the <summary> tags' content alone
  expect(note).not.toContain('<summary>')
  // the person's latest words follow the summary (the view no longer holds their message), then the pending tail's
  // result rides in the compaction request as text, whole
  expect(marker.parts.map((p) => userText(p as never)).slice(1, 3)).toEqual([PROMPT_TEXT['compaction.person_words'], 'build it'])
  const carried = userText(marker.parts.at(-1) as never)
  expect(carried).toStartWith('Result of tool call tc_5 (bash), returned just before the summary:')
  expect(carried).toContain(LONG.trim())
  expect(marker.parts).toHaveLength(4)
  // the model reads from the compaction on
  expect(workingView(out)).toEqual([marker])
  expect(tight.currentAnchor()).toBeNull()                                                // the anchor was of the old view
  // appended to and asked again with the provider's count of the new view: nothing happens under the threshold
  const later = [...out, ...block(6, { status: 'ok' })]
  const [kept, quiet] = await tight.maybeCompact(later, seam(model, { input_tokens: 900, messages: out.length }))
  expect(kept).toBe(later)
  expect(quiet).toBeNull()
  expect(seen).toHaveLength(1)
})

test('a summary that could not be had leaves the record as it is and says why', async () => {
  const messages = history(6)
  const tight = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  const over = { input_tokens: 11_400, messages: messages.length - 2 }
  const calls = scriptedModel(() => modelResponse([toolCallPart('bash', { command: 'ls' }, 'oops')]))
  const [same, report] = await tight.maybeCompact(messages, seam(calls, over))
  expect(same).toBe(messages)
  expect(report!.status).toBe('failed')
  expect(report!.reason).toContain('called a tool')
  const broken = scriptedModel(() => { throw new Error('boom') })
  const [again, failed] = await tight.maybeCompact(messages, seam(broken, over))
  expect(again).toBe(messages)
  expect(failed!.reason).toContain('boom')
  const silent = scriptedModel(() => modelResponse([textPart('   ')]))
  expect((await tight.maybeCompact(messages, seam(silent, over)))[1]!.reason).toContain('no summary')
  expect(summaryOf('x <summary> y </summary> z')).toBe('y')
  expect(summaryOf('plain words')).toBe('plain words')
})

test('a summary that names its own tags in its words is kept whole, up to its last closing tag', () => {
  // seen on gpt-6.1-sol: the summary quoted the request's "`<summary></summary>` tags" and was cut at the quote
  const body = 'Constraints: never touch vendor/.\nThe request asked for text only within `<summary></summary>` tags.\nDone: A, B. Next: C (caching) and D (TODO).'
  expect(summaryOf(`<summary>\n${body}\n</summary>`)).toBe(body)
  expect(summaryOf('before <summary>\nall done\n</summary> after')).toBe('all done')
})

test("when even the summary request would not leave the output its room, the tail's results are left out of it — and ride in the compaction request", async () => {
  const seen: ModelMessage[][] = []
  const model = summarizer(seen)
  const messages = history(6)
  // Input budget 19_000: the counted prefix (18_400) leaves room for the summary prompt, but not the tail too.
  // The old 18_900 anchor left less than the summary overhead even after omitting the tail.
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 1_000 })
  const [out, report] = await keeper.maybeCompact(messages, seam(model, { input_tokens: 18_400, messages: messages.length - 1 }))
  expect(report!.status).toBe('compacted')
  const askedTail = seen[0]![seen[0]!.length - 1] as ModelRequest
  const omitted = askedTail.parts.filter(isToolReturn)[0]!
  expect(omitted.content).toBe('[omitted from the summary request: the result rides in the compaction request]')
  const marker = out[out.length - 1] as ModelRequest
  expect(userText(marker.parts.at(-1) as never)).toContain(LONG.trim())
  // an image a tail's result carried stays a reference in the compaction request (the bytes join at the boundary)
  const image = imagePiece({ asset_id: 'a_1', media_type: 'image/png', bytes: 3, sha256: 'abc', width: 1, height: 1, name: 'r.png' })
  const withImage = [...history(2), ...block(2, { status: 'ok', path: 'r.png', image })]
  const [pictured] = await new ContextKeeper({ window: 20_000, output_reserve: 500 }).maybeCompact(withImage, seam(summarizer(), { input_tokens: 11_400, messages: withImage.length - 1 }))
  const last = pictured[pictured.length - 1] as ModelRequest
  const carried = last.parts.at(-1)!
  expect(isUserPrompt(carried) && Array.isArray(carried.content) && carried.content[1]).toEqual(image)
})

test('dangling calls are answered only in the working view; the model boundary carries the view to the route\'s provider', () => {
  const before = history(2)
  const dangling: ModelMessage[] = [...before, modelResponse([toolCallPart('bash', { command: 'never answered' }, 'tc_lost')])]
  const marker: ModelRequest = { ...modelRequest([userPrompt('App note: s')], INSTRUCTIONS), compaction: { covers: dangling.length, tokens_before: 1, summary_input_tokens: 1, model: 'm', at: 't' } }
  const record = [...dangling, marker]
  expect(closeDanglingToolCalls(record)).toBe(record)                                   // the lost call is summarized, not answered
  const open = [...record, ...block(7).slice(0, 1)]
  const closed = closeDanglingToolCalls(open)
  expect(closed).toHaveLength(open.length + 1)
  expect((closed[closed.length - 1] as ModelRequest).parts.filter(isToolReturn)[0]!.tool_call_id).toBe('tc_7')
  // the boundary: the wrapped model receives the view, foreign reasoning left out, the record untouched
  const received: ModelMessage[][] = []
  const inner = stampedModel((messages) => { received.push(messages); return modelResponse([textPart('ok')]) }, 'openai', 'gpt')
  const view = new ContextView(inner, 'openai')
  return view.request(open, {}, PARAMS).then(() => {
    const got = received[0]!
    expect(got).toHaveLength(open.length - dangling.length)
    expect(got[0]).toBe(marker)
    const response = got[1]!
    expect(response.kind).toBe('response')
    expect(response.kind === 'response' && response.parts.some((p) => p.part_kind === 'thinking')).toBe(false)       // anthropic's reasoning stays home
    expect(open[dangling.length + 1]!.kind === 'response' && open[dangling.length + 1]!.parts.some((p) => p.part_kind === 'thinking')).toBe(true)
  })
})

test('the persisted form round-trips byte for byte, and the transcript shows a legacy compaction once without inventing its after count', () => {
  const image = imagePiece({ asset_id: 'a_1', media_type: 'image/png', bytes: 3, sha256: 'abc', width: 1, height: 1, name: 'r.png' })
  const record: ModelMessage[] = [
    modelRequest([userPrompt(['look', image])], INSTRUCTIONS),
    modelResponse([thinkingPart('t', { signature: 'sig', provider_name: 'anthropic' }), toolCallPart('bash', { command: 'ls', nested: { z: 1, a: [1, 'two', null] } }, 'tc_1', { provider_name: 'anthropic' })], { provider_name: 'anthropic', provider_response_id: 'msg_1', usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 } }),
    modelRequest([toolReturn('bash', { status: 'ok', stdout: 'é…🪷', image }, 'tc_1')], INSTRUCTIONS),
    { ...modelRequest([userPrompt('App note: The conversation so far was summarized. S.'), userPrompt('Result of tool call tc_1 (bash), returned just before the summary:\nx')], INSTRUCTIONS), compaction: { covers: 3, tokens_before: 100, summary_input_tokens: 90, model: 'm', at: 't' } },
    modelResponse([textPart('done')]),
  ]
  const once = dumpJson(record)
  expect(dumpJson(loadJson(once))).toBe(once)
  expect(dumpJson(loadJson(dumpJson(loadJson(once))))).toBe(once)
  const entries = rebuildTranscript(once)
  expect(entries.map((e) => e.kind)).toEqual(['user', 'thinking', 'activity', 'compaction', 'agent'])
  expect(entries[3]!.compaction).toEqual({ status: 'compacted', estimate_tokens: 100, after_tokens: null })
  expect(JSON.stringify(entries)).not.toContain('returned just before the summary')
  expect(countTokens('a b c')).toBeGreaterThan(0)
})

test('the estimate counts what the requests carry, not the record: ids, timestamps, usage and escaping of a tool-heavy record add nothing', () => {
  const messages: ModelMessage[] = [modelRequest([userPrompt('read the parser and its tests')], 'sys')]
  for (let i = 0; i < 40; i += 1) {
    const id = `call_${i.toString().padStart(4, '0')}_${'a'.repeat(24)}`
    messages.push(modelResponse([toolCallPart('read_file', { path: `src/parser_${i}.ts` }, id)], {
      usage: { input_tokens: 1000 + i, output_tokens: 20, cache_read_tokens: 900, cache_write_tokens: 0 } as never, model_name: 'gpt-6-astra', timestamp: '2026-10-17T00:00:00.000Z',
      provider_details: { response_id: `resp_${'b'.repeat(40)}_${i}`, service_tier: 'default' },
    } as never))
    messages.push(modelRequest([toolReturn('read_file', { content: `export const x${i} = "a \\"quoted\\" value"\n`.repeat(3), sha256: 'c'.repeat(64) }, id, { at: '2026-10-17T00:00:01.000Z' })], 'sys'))
  }
  const wire = countTokens(wireText(messages))
  const record = countTokens(JSON.stringify(messages))
  expect(estimateMessages(messages)).toBe(wire)
  expect(estimateMessages(messages)).toBeLessThan(record * 0.6)
})
