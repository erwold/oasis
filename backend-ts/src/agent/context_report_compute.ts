/** Pure report arithmetic. Runs in the report worker in production: parsing/validating history, building wire
 * text, serializing byte proxies and even the encoder's FIRST initialization belong there, not on the API loop.
 * No AppState, connection, database path or credentials cross this boundary. The synchronous entry is retained
 * for callers/tests; runner prediction and its countTokens/ContextKeeper contracts are unchanged. */
import { CONTEXT_REPORT_SCHEMA, refNativeFor, type ContextReport, type RequestLimits } from '@oasis-code/contract'
import type { ModelConfig } from '../config.ts'
import { isRefPiece } from '../llm/attachments.ts'
import { isRequest, isResponse, isToolReturn, isUserPrompt, loadValue, type ModelMessage } from '../llm/messages.ts'
import { CONTEXT_MARGIN, countTokens, encoderOrNull, ESTIMATE_FACTOR, legacyFileCost, nativeRefCost, WINDOW_SHARE, wireText, type WindowResolution } from './context.ts'
import { compactionCount, ContextKeeper, messageContentBytes, workingView, type ContextAnchor } from './history.ts'

export interface ContextReportInput {
  sessionId: string
  modelId: string
  route: Pick<ModelConfig, 'id' | 'provider' | 'capabilities'> | null
  fileLimits: RequestLimits | null
  resolved: WindowResolution
  reserve: number
  seed: { anchor: ContextAnchor | null; trigger: number | null }
  runModel: string | null
  lastRun: Record<string, unknown> | null
  historyJson: string | null
  text: string
  names: string[]
  payloads: string[]
  schemaEstimateText: string
  installedLabel: string | null
}

export interface ContextReportResult {
  report: ContextReport
  /** Only installed arbitrary counters need a callback in the caller's realm. In original invocation order:
   * history (if present), instructions, schema display. No function source is serialized/evaluated. */
  counterTexts: string[] | null
}

export const TOKENIZER = 'o200k_base'
export type Counter = (text: string) => number

/** [counter, its label, a note] for the route the next request goes to: an OpenAI route counts locally with
 *  o200k_base; an Anthropic route's tokenizer is not public — no count (the keeper's prediction stands in,
 *  labelled) unless a counter was installed for it; any other route gets no count. */
export function resolveReportCounter(cfg: Pick<ModelConfig, 'id' | 'provider'> | null, installed?: [Counter, string]): [Counter | null, string | null, string] {
  const modelId = cfg ? cfg.id : null
  if (installed) return [installed[0], installed[1], `counted with ${installed[1]} (installed for ${modelId})`]
  if (cfg === null || cfg.provider === 'openai') {
    if (encoderOrNull() === null) return [null, null, `tiktoken ${TOKENIZER} is not available here, so no tokens are counted`]
    return [countTokens, TOKENIZER, `counted with tiktoken ${TOKENIZER} (the OpenAI vocabulary; ${modelId ?? 'openai'})`]
  }
  if (cfg.provider === 'anthropic') return [null, null, `Anthropic's tokenizer is not public and no counter is installed for ${modelId}, so no tokens are counted`]
  return [null, null, `no tokenizer known for ${modelId}, so no tokens are counted`]
}

/** Counted tokens of every part's text on the wire, as one text (instructions not included: they go once, as the instructions segment). */
export function messageTokens(messages: ModelMessage[], counter: Counter | null): number | null {
  if (counter === null) return null
  return counter(wireText(messages))
}

function historySection(historyJson: string | null, messages: ModelMessage[], counter: Counter | null): Record<string, unknown> {
  const base = {
    bytes_basis: 'raw_bytes: the stored record; content_bytes: the record with the per-request instructions field '
      + "cleared — a proxy for the conversation's size that still carries record metadata (usage, provider "
      + 'ids, timestamps); wire_bytes: the same proxy of the working view (the record from its last compaction on) '
      + "— what a request carries; none of these is the sent content, the provider's request size or tokens",
  }
  if (!historyJson) {
    return { messages: 0, raw_bytes: 0, content_bytes: 0, wire_bytes: 0, wire_tokens: counter !== null ? 0 : null, compactions: 0, tool_returns: 0, model_turns: 0, user_turns: 0, ...base }
  }
  const wire = workingView(messages)
  return {
    messages: messages.length, raw_bytes: Buffer.byteLength(historyJson, 'utf8'), content_bytes: messageContentBytes(messages), wire_bytes: messageContentBytes(wire),
    wire_tokens: messageTokens(wire, counter), compactions: compactionCount(messages),
    tool_returns: messages.filter(isRequest).flatMap((m) => m.parts).filter(isToolReturn).length,
    model_turns: messages.filter(isResponse).length,
    user_turns: messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt).length,
    ...base,
  }
}

export function computeContextReport(input: ContextReportInput, installedCounter?: Counter): ContextReportResult {
  const { sessionId, modelId, route, fileLimits, resolved, reserve, seed, runModel, lastRun, historyJson, text, names, payloads, schemaEstimateText } = input
  const counterTexts: string[] | null = input.installedLabel !== null && !installedCounter ? [] : null
  const installed: [Counter, string] | undefined = input.installedLabel !== null
    ? [installedCounter ?? ((text) => { counterTexts!.push(text); return 0 }), input.installedLabel] : undefined
  const [counter, tokenizer, counterNote] = resolveReportCounter(route, installed)
  // Exactly routeFileCost's policy, using only the already-resolved capabilities/limits (no runner import).
  const fileCost = route !== null && fileLimits !== null
    ? (piece: Parameters<typeof legacyFileCost>[0] | Parameters<typeof nativeRefCost>[0]) => isRefPiece(piece)
      ? (refNativeFor(route.capabilities, fileLimits, piece) ? nativeRefCost(piece) : 0) : legacyFileCost(piece)
    : undefined
  const keeper = new ContextKeeper({ window: resolved.window, output_reserve: reserve, anchor: seed.anchor, trigger: seed.trigger, file_cost: fileCost })
  const raised = keeper.currentTrigger()
  const budget = raised ?? keeper.threshold
  const budgetSource = `the smaller of ${WINDOW_SHARE * 100} % of the window and the window less the output reserve (${reserve.toLocaleString('en-US')}) and a margin of ${CONTEXT_MARGIN.toLocaleString('en-US')} tokens`
    + (raised !== null ? `, raised to ${raised.toLocaleString('en-US')} after a compaction that freed too little` : '')
  const schemaBytes = payloads.reduce((a, p) => a + Buffer.byteLength(p, 'utf8'), 0)
  const messages: ModelMessage[] = historyJson ? loadValue(JSON.parse(historyJson)) : []
  const history = historySection(historyJson, messages, counter)
  const instructionTokens = countTokens(text)
  const schemaTokens = countTokens(schemaEstimateText)
  const estimated = keeper.estimate(messages, () => instructionTokens + schemaTokens)
  // a run still at work has stored no anchor yet: the keeper's own prediction for its latest request (anchored on the
  // provider's counts as the run goes) is the closer figure than an estimate of the whole record
  const latest = lastRun?.last_request_context_estimate
  const running = estimated.basis === 'estimate' && runModel === modelId && typeof latest === 'number' && latest > 0
  const prediction = running ? { tokens: latest, basis: 'latest_request' as const } : estimated
  const fixedEst = { instructions: Math.ceil(instructionTokens * ESTIMATE_FACTOR), tool_schemas: Math.ceil(schemaTokens * ESTIMATE_FACTOR) }
  // each part rounded up on its own can pass the prediction (the whole rounded up once) by a token: the tools give it back
  if (fixedEst.instructions + fixedEst.tool_schemas === prediction.tokens + 1) fixedEst.tool_schemas -= 1
  const segments: Record<string, unknown>[] = [
    { key: 'instructions', label: 'Fixed instructions', bytes: Buffer.byteLength(text, 'utf8'), tokens: counter ? counter(text) : null, sent: 'every request', note: 'the system instructions (sent once per request)' },
    { key: 'tool_schemas', label: 'Tool schemas', bytes: schemaBytes, tokens: counter ? counter(payloads.join('\n')) : null, sent: 'every request', count: names.length,
      note: "name + description + input schema per tool (counted on the harness's JSON of them; the provider's own framing adds a little)" },
    { key: 'history', label: 'Conversation (working view, instructions cleared)', bytes: history.wire_bytes, tokens: history.wire_tokens, sent: 'every request', count: history.messages,
      note: `${history.user_turns} user turn(s), ${history.model_turns} model turn(s), ${history.tool_returns} tool result(s); `
        + `a proxy: the record from its last compaction on (${history.compactions} compaction(s) in the record) in the record's `
        + `JSON with the per-request instructions field cleared, record metadata still counted — not the provider request; `
        + `${history.content_bytes} bytes of the whole record, ${history.raw_bytes} bytes as stored` },
  ]
  const total = segments.reduce((a, s) => a + (s.bytes as number), 0)
  const counted = segments.every((s) => s.tokens !== null && s.tokens !== undefined)
  const totalTokens = counted ? segments.reduce((a, s) => a + (s.tokens as number), 0) : null
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4
  // the fixed part's scaled estimate, and the conversation as the rest of the prediction: the segments add up to it
  const segmentEst: Record<string, number> = { ...fixedEst, history: Math.max(0, prediction.tokens - fixedEst.instructions - fixedEst.tool_schemas) }
  for (const segment of segments) {
    segment.share = counted && totalTokens ? round4((segment.tokens as number) / totalTokens) : total ? round4((segment.bytes as number) / total) : 0
    segment.tokens_est = segmentEst[segment.key as string]!
  }
  const estimateBasis = prediction.basis === 'latest_request'
    ? `the context keeper's prediction for the run's latest request, anchored on the provider's counts during the run; the instructions and tools are estimated with ${TOKENIZER} ×${ESTIMATE_FACTOR}, the conversation is the rest`
    : prediction.basis === 'anchor'
    ? `the context keeper's prediction for the next request: the provider's count of the last run's last request plus the estimate of the ${messages.length - (seed.anchor?.messages ?? 0)} message(s) after it (×${ESTIMATE_FACTOR}); the instructions and tools are estimated with ${TOKENIZER} ×${ESTIMATE_FACTOR}, the conversation is the rest`
    : `the context keeper's prediction for the next request: the instructions, the tools and the working view estimated with ${TOKENIZER} ×${ESTIMATE_FACTOR} (no provider count on this record and route to anchor on)`
  const reported = lastRun?.last_request_input_tokens as number | null | undefined
  const tokensBasis = counted
    ? `${counterNote}, on the text the harness assembles (instructions once, the tools' JSON, every message part's text on the wire)`
      + (reported ? `; the provider reported ${reported.toLocaleString('en-US')} input tokens on the last run's last request` : '')
    : `${counterNote}; the estimate is the context keeper's prediction`
  const report = {
    schema_version: CONTEXT_REPORT_SCHEMA, session_id: sessionId, model_id: modelId, total_bytes: total, total_tokens: totalTokens, tokenizer: counted ? tokenizer : null,
    context_window: resolved.known ? resolved.window : null, context_window_source: resolved.source, budget_tokens: budget, budget_source: budgetSource,
    budget_note: 'the record is only appended to; when the next request is predicted to exceed this threshold the model summarizes the '
      + 'conversation and reads on from the summary (the record keeps every earlier message); between compactions every request is a prefix extension of the previous one',
    tokens_basis: tokensBasis,
    bytes_basis: 'the record\'s JSON of what the harness assembles: instructions once, tool schemas, and a proxy for the '
      + "conversation's working view (the stored record from its last compaction on, with the repeated instructions cleared, record metadata "
      + "still counted); not the provider's wire bytes, not the sent content and not tokens",
    tokens_est: prediction.tokens, estimate_basis: estimateBasis,
    segments, per_message: ['the workspace line', "project instructions (a thread's first request)", 'session grants', 'hard limits', 'harness notes (handoff, recovery)', 'your request'],
    tools: names, history, last_run: lastRun,
  } as ContextReport
  return { report, counterTexts }
}

/** Complete only the display counts for an installed callback. The worker has already done all built-in
 * estimation. Deliberately do not memoize callbacks: even a stateful counter sees the original call order. */
export function finishInstalledCounter(result: ContextReportResult, counter: Counter): ContextReport {
  const { report, counterTexts } = result
  if (counterTexts === null) return report
  const values = counterTexts.map((text) => counter(text))
  const historyTokens = values.length === 3 ? values.shift()! : 0
  report.history.wire_tokens = historyTokens
  for (const segment of report.segments) {
    segment.tokens = segment.key === 'history' ? historyTokens : values.shift()!
  }
  const totalTokens = report.segments.reduce((sum, segment) => sum + segment.tokens!, 0)
  report.total_tokens = totalTokens
  for (const segment of report.segments) {
    segment.share = totalTokens ? Math.round((segment.tokens! / totalTokens) * 1e4) / 1e4
      : report.total_bytes ? Math.round((segment.bytes / report.total_bytes) * 1e4) / 1e4 : 0
  }
  return report
}
