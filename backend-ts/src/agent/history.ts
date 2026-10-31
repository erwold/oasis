import { isFilePiece, isRefPiece } from '../llm/attachments.ts'
/** The working context: what a model receives of a conversation's record, and when the record is compacted.
 *
 *  The record (the loop's message list, the stash, the stored history) is only ever appended to: what a provider
 *  received once is never rewritten, so every request is a prefix extension of the one before and the provider's
 *  prompt cache reads the whole earlier conversation. The model receives the record from its last compaction on
 *  (`workingView`): a compaction is one request appended to the record whose first part is the summary of
 *  everything before it, then the person's latest words when the pending tail does not hold them, then the pending
 *  tail (the person's words, the tool results in hand) said again as text — the simple shape, replaying no earlier
 *  turn and no earlier reasoning, which is what a provider that binds reasoning to its conversation accepts.
 *
 *  A compaction happens only when the next request would come close to the route's window (`ContextKeeper`): the
 *  size is predicted from the provider's own count of the last request plus an estimate of what was added since,
 *  the summary is the model's (asked from the same context, so the summary request reads the cache too), and the
 *  record keeps every earlier message for the person and the transcript. */

import type { Compaction } from '@oasis-code/contract'
import { isImagePiece, returnHasImage } from '../llm/images.ts'
import { portableHistory } from '../llm/handoff.ts'
import {
  APP_ORIGIN, isRequest, isResponse, isText, isToolCall, isToolReturn, isRetryPrompt, isUserPrompt, modelRequest, retryText, userPrompt, userText,
  type ModelMessage, type ModelRequest, type RequestPart, type ResponsePart, type UserContent, type UserPromptPart,
} from '../llm/messages.ts'
import {
  WrapperModel, type Model, type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamedResponse, type ToolDefinition,
} from '../llm/model.ts'
import { THINKING_BUDGETS, thinkingLevel, toolReturnText } from '../llm/providers/common.ts'
import { nowIso } from '../timebase.ts'
import { compactionThreshold, countTokens, defaultFileCost, estimateMessages, ESTIMATE_FACTOR, imageCount, IMAGE_TOKENS, strippedRecord, type FileCost } from './context.ts'
import type { ContextAnchor, RequestSeam } from './loop.ts'
import { PROMPT_TEXT, text as promptText } from '../prompt_texts.ts'
import { isSteerPart, withTailParts } from './steering.ts'

export type { ContextAnchor, RequestSeam }

// ---- the working view --------------------------------------------------------------------------------------

export type CompactionRequest = ModelRequest & { compaction: Compaction }

export function isCompaction(message: ModelMessage): message is CompactionRequest {
  return isRequest(message) && message.compaction !== undefined && message.compaction !== null
}

/** The index of the last compaction request (-1 when the record holds none). */
export function compactionIndex(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (isCompaction(messages[i]!)) return i
  return -1
}

export function compactionCount(messages: ModelMessage[]): number {
  return messages.filter(isCompaction).length
}

/** The messages as the model receives them: the record from its last compaction on; the same array when there
 *  is none. Pure: the messages it returns are the record's own objects. */
export function workingView(messages: ModelMessage[]): ModelMessage[] {
  const at = compactionIndex(messages)
  return at <= 0 ? messages : messages.slice(at)
}

/** The record of the working view with the repeated instructions cleared: the proxy the records keep for what a
 *  request carries (never the provider's bytes, never tokens). */
export function messageContentBytes(messages: ModelMessage[]): number {
  return Buffer.byteLength(strippedRecord(messages), 'utf8')
}

/** Observation telemetry for a run's record: the stored bytes, the record's content proxy, the working view's
 *  proxy (what a request carries) and how many compactions the record holds. */
export function historyMetrics(messages: ModelMessage[], historyJson?: string | null): Record<string, number> {
  const metrics: Record<string, number> = { history_messages: messages.length }
  if (historyJson !== null && historyJson !== undefined) metrics.history_bytes = Buffer.byteLength(historyJson, 'utf8')
  try {
    metrics.history_content_bytes = messageContentBytes(messages)
    metrics.history_wire_bytes = messageContentBytes(workingView(messages))
    metrics.history_compactions = compactionCount(messages)
  } catch { /* telemetry must never block persisting the run */ }
  return metrics
}

/** The provider boundary: the wrapped model receives the working view, carried to its route through the handoff
 *  (reasoning and native references of another provider, endpoint or model left out, deterministically, on every
 *  request); the caller's messages — the loop's state, the stash, the record — stay the whole record. */
export class ContextView extends WrapperModel {
  constructor(wrapped: Model, readonly target: string) { super(wrapped) }
  view(messages: ModelMessage[]): ModelMessage[] {
    return portableHistory(workingView(messages), this.target, this.route)[0]
  }
  override request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext) {
    return this.wrapped.request(this.view(messages), settings, params, ctx)
  }
  override requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    return this.wrapped.requestStream(this.view(messages), settings, params, ctx)
  }
  override countTokens(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters) {
    return super.countTokens(this.view(messages), settings, params)
  }
}

// ---- the keeper: prediction and compaction -----------------------------------------------------------------------

export interface ContextPrediction {
  tokens: number
  /** anchor: the provider's count of the last request plus the estimate of what was added; estimate: the whole
   *  view estimated (a fresh conversation, a new route, the request after a compaction) */
  basis: 'anchor' | 'estimate'
}

/** A provider refused a request for its size and the one recovery could not make a smaller working view: the run
 *  ends here (the same request is not sent again), its record kept whole. */
export class ContextOverflowUnrecovered extends Error {
  constructor(reason: string) { super(`the conversation does not fit the model's window and could not be made smaller: ${reason}`); this.name = 'ContextOverflowUnrecovered' }
}

/** The longest a text part may be in a recovery's summary request and in its compaction request's tail; a longer one
 *  is cut there with a note saying so (the record keeps it whole). */
export const RECOVERY_PART_CHARS = 8_000
/** The shortest a compaction request's tail cuts a result to when even RECOVERY_PART_CHARS each would leave the next
 *  request no room for its output (a window whose fixed part — instructions, tools — leaves little beside it). */
export const TAIL_PART_MIN_CHARS = 500

/** Summary finishes that are not a whole summary: cut at the output limit, filtered or refused, ended by an error. */
const INCOMPLETE_SUMMARY = new Set(['length', 'content_filter', 'error'])

/** The share of the threshold a summary may fill: the rest is room for the instructions, the tools, the pending tail
 *  and the work that follows. The summary request tells the model this room; a summary that still runs longer is
 *  shortened line by line, its longest lines first (each cut where it is, with a note saying how much), so the short
 *  lines — the constraints and decisions the prompt asks for on lines of their own — stay whole wherever they stand. */
export const SUMMARY_SHARE = 0.25

/** The share of the threshold the person's latest words may fill when a compaction carries them from before it (the
 *  summary request read them whole; a longer copy is cut with a note). */
export const PERSON_SHARE = 0.2

/** The fewest characters a summary line is shortened to before whole lines are left out. */
const MIN_LINE_CHARS = 200

/** A compaction whose view the provider counts above this share of the threshold (its count of the first request
 *  after it; the estimate until that count comes) freed too little: the next one waits until the view has grown by
 *  this share of the threshold past that count — never past the window less the output's room — instead of coming
 *  again after the next step. */
export const BACKOFF_SHARE = 0.5

export interface CompactionReport {
  status: 'compacted' | 'failed' | 'skipped'
  /** threshold: the next request was predicted near the window; overflow: the provider refused a request for its size */
  trigger?: 'threshold' | 'overflow'
  estimate_tokens: number
  after_tokens: number | null
  threshold_tokens: number
  window_tokens: number
  covers: number
  summary_chars: number
  summary_input_tokens: number | null
  /** characters of the model's summary left out to hold it to SUMMARY_SHARE of the threshold */
  summary_cut_chars?: number
  /** the prediction this compaction was asked over: the threshold, or a higher line after one that freed too little */
  trigger_tokens?: number
  reason?: string
}

/** The output size a request may need under the window: the settings' cap, raised as the Anthropic mapping raises
 *  it when thinking has a budget the cap would not hold. */
export function outputReserve(settings: ModelSettings): number {
  const cap = settings.max_tokens ?? 4096
  const level = thinkingLevel(settings.thinking ?? null)
  const budget = level ? THINKING_BUDGETS[level]! : 0
  return cap <= budget ? budget + 4096 : cap
}

export interface KeeperOptions {
  window: number
  output_reserve: number
  anchor?: ContextAnchor | null
  /** the line an earlier keeper on the same record and route had moved to (a compaction that freed too little) */
  trigger?: number | null
  /** what a file piece costs on this route (a reference the route takes natively, or its note): the estimate is the
   *  request as it will be materialized, never a file's size where only its path travels */
  file_cost?: FileCost
}

export class ContextKeeper {
  readonly window: number
  readonly output_reserve: number
  readonly threshold: number
  /** the prediction over which a compaction is asked: the threshold, raised after a compaction that freed too little */
  private trigger: number
  /** a compaction was made and the provider has not counted a request after it yet */
  private countPending = false
  private anchor: ContextAnchor | null
  private last: ContextPrediction | null = null
  /** the provider's refusal a recovery answers: the next call compacts whatever the prediction says, or throws */
  private overflow: string | null = null
  private readonly fileCost: FileCost

  constructor(o: KeeperOptions) {
    this.fileCost = o.file_cost ?? defaultFileCost
    this.window = o.window
    this.output_reserve = o.output_reserve
    this.threshold = compactionThreshold(o.window, o.output_reserve)
    const seeded = o.trigger
    this.trigger = typeof seeded === 'number' && Number.isFinite(seeded) && seeded > this.threshold
      ? Math.min(Math.floor(seeded), Math.max(this.threshold, this.window - this.output_reserve)) : this.threshold
    this.anchor = o.anchor && this.countable(o.anchor) ? o.anchor : null
  }

  /** The last request's count and the record's length at the time: what the next prediction anchors on (the
   *  next run's keeper is seeded with it when it continues this record on the same route). */
  currentAnchor(): ContextAnchor | null { return this.anchor }

  /** The line the next compaction waits for when a compaction moved it above the threshold (null: the threshold) —
   *  kept with the anchor, so the next run on this record and route does not summarize the summary at once. */
  currentTrigger(): number | null { return this.trigger > this.threshold ? this.trigger : null }

  lastPrediction(): ContextPrediction | null { return this.last }

  /** A count the prediction can stand on: a whole number of tokens above zero that the window could hold (a provider
   *  that reports none, a negative or endless one, or more than the window is not counting this request). */
  private countable(anchor: ContextAnchor): boolean {
    return Number.isFinite(anchor.input_tokens) && anchor.input_tokens > 0 && anchor.input_tokens <= this.window
      && Number.isInteger(anchor.messages) && anchor.messages > 0
  }

  observe(anchor: ContextAnchor): void {
    if (!this.countable(anchor)) return
    this.anchor = anchor
    if (this.countPending) {
      this.countPending = false
      this.trigger = this.nextTrigger(anchor.input_tokens)
    }
  }

  /** The provider's count of the last request the record holds from `from` on (the run's own requests): a run's last
   *  response is followed by no request that would bring its count to the keeper, so the run observes it as it ends —
   *  the anchor and the line the next run is seeded with stand on it. */
  observeLast(messages: ModelMessage[], from: number): void {
    for (let i = messages.length - 1; i >= Math.max(from, 1); i -= 1) {
      const m = messages[i]!
      if (!isResponse(m)) continue
      if (typeof m.usage?.input_tokens === 'number') this.observe({ input_tokens: m.usage.input_tokens, messages: i })
      return
    }
  }

  /** The line the next compaction waits for, given the size of the view a compaction left. */
  private nextTrigger(after: number): number {
    if (after <= this.threshold * BACKOFF_SHARE) return this.threshold
    return Math.max(this.threshold, Math.min(after + Math.ceil(this.threshold * BACKOFF_SHARE), this.window - this.output_reserve))
  }

  /** The provider refused the last request for its size: the next call makes a smaller working view (a compaction
   *  whose summary request and tail carry no text part longer than RECOVERY_PART_CHARS) or ends the run. */
  recoverFromOverflow(reason: string): void {
    this.overflow = reason
    this.anchor = null
    this.countPending = false
  }

  /** The tokens the next request would carry: the anchor plus the scaled estimate of the messages appended since
   *  (an anchor from before the last compaction is no anchor), else the scaled estimate of the whole view with the
   *  instructions and the tools. */
  predict(messages: ModelMessage[], seam: Pick<RequestSeam, 'instructions' | 'params'>): ContextPrediction {
    const prediction = this.estimate(messages, () => countTokens(seam.instructions) + countTokens(toolsText(seam.params.function_tools)))
    this.last = prediction
    return prediction
  }

  /** The prediction itself, with the fixed part (the instructions and the tools, in unscaled tokens) asked only when
   *  there is no anchor to stand on. */
  estimate(messages: ModelMessage[], fixedTokens: () => number): ContextPrediction {
    const at = compactionIndex(messages)
    const anchor = this.anchor
    if (anchor !== null && anchor.messages > at && anchor.messages <= messages.length) {
      const delta = messages.slice(anchor.messages)
      return { tokens: anchor.input_tokens + Math.ceil(estimateMessages(delta, this.fileCost) * ESTIMATE_FACTOR) + imageCount(delta) * IMAGE_TOKENS, basis: 'anchor' }
    }
    const view = workingView(messages)
    return { tokens: Math.ceil((fixedTokens() + estimateMessages(view, this.fileCost)) * ESTIMATE_FACTOR) + imageCount(view) * IMAGE_TOKENS, basis: 'estimate' }
  }

  /** The messages the loop goes on with: the same when the next request fits under the threshold; otherwise the
   *  record with a compaction request appended — or, when the summary could not be had, the same record and a
   *  report that says why (the request is then made as it is; the provider decides). */
  async maybeCompact(messages: ModelMessage[], seam: RequestSeam, pending: RequestPart[] = [], onStart?: () => void): Promise<[ModelMessage[], CompactionReport | null]> {
    const overflow = this.overflow
    this.overflow = null
    if (seam.observed) this.observe(seam.observed)
    // the person's words waiting to join this request (in-run steering) are counted as if they were in it: they go
    // whole, so the room is made for them here, not by cutting them later
    const withPending = (ms: ModelMessage[]) => withTailParts(ms, pending)
    const prediction = this.predict(withPending(messages), seam)
    if (overflow === null && prediction.tokens <= this.trigger) return [messages, null]
    const tail = messages[messages.length - 1]
    const base: Omit<CompactionReport, 'status' | 'after_tokens' | 'summary_chars' | 'summary_input_tokens'> = {
      trigger: overflow !== null ? 'overflow' : 'threshold',
      estimate_tokens: prediction.tokens, threshold_tokens: this.threshold, window_tokens: this.window, covers: messages.length,
      ...(overflow === null ? { trigger_tokens: this.trigger } : {}),
    }
    // after the provider's refusal a failed attempt ends the run: the request it refused is not sent again as it was
    const failed = (reason: string): [ModelMessage[], CompactionReport] => {
      if (overflow !== null) throw new ContextOverflowUnrecovered(reason)
      return [messages, { ...base, status: 'failed', after_tokens: null, summary_chars: 0, summary_input_tokens: null, reason }]
    }
    if (!tail || !isRequest(tail)) return failed('the record does not end with a request')
    // a summary is a request: with none left in the budget it is not asked — the request is then made as it is (the
    // closing one) and the provider decides
    if (seam.requests_left != null && seam.requests_left < 1) {
      if (overflow !== null) throw new ContextOverflowUnrecovered('the request budget has no request left for a summary')
      return [messages, { ...base, status: 'skipped', after_tokens: null, summary_chars: 0, summary_input_tokens: null, reason: 'the request budget has no request left for a summary' }]
    }
    const view = workingView(messages)
    const prompt = promptText('compaction.request')
    // the summary is asked from the context as it stands (the cache reads it); when even that would not leave the
    // output its room, the tail's tool results are left out of the summary request — they ride in the compaction
    // request itself, whole while it leaves the output its room. After the provider refused the context for its size,
    // the summary request carries no text longer than RECOVERY_PART_CHARS (each cut one says so), and neither does
    // the compaction's tail.
    const summaryLimit = Math.floor(this.threshold * SUMMARY_SHARE)
    const room = userPrompt(promptText('compaction.summary_room', { words: Math.max(1, Math.floor((summaryLimit / ESTIMATE_FACTOR) * 0.75)) }), APP_ORIGIN)
    const roomy = overflow === null && prediction.tokens + countTokens(`${userText(room)}${prompt}`) * ESTIMATE_FACTOR <= this.window - this.output_reserve
    // the person's latest words are what the conversation is for: every compaction request carries them when its tail
    // does not hold them already — after a refusal for size whole (and whole in the summary request too), else up to
    // PERSON_SHARE of the threshold. The summary request tells the model the room its summary has.
    const person = new Set(personTurn(view))
    const asked = withPrompt(overflow !== null ? boundedView(withReturnsOmitted(view), person) : roomy ? view : withReturnsOmitted(view), [room, userPrompt(prompt, APP_ORIGIN)])
    let summary: string
    let summaryInput: number | null = null
    let modelName: string | null = null
    // Only an actual summary request starts progress, never a below-threshold / backoff / budget skip.
    onStart?.()
    try {
      // streamed like every other request (a summary can run long), drained here: nothing of it is shown as it forms;
      // it carries the run's Stop, and it counts as one of the run's requests once it has gone out
      // counted as it goes out: a summary the provider refused is a request spent all the same
      if (seam.spent) seam.spent.requests += 1
      const stream = await seam.model.requestStream(asked, seam.settings, seam.params, seam.ctx)
      for await (const _ of stream.events()) { /* drain */ }
      const response = stream.get()
      if (response.usage && seam.spent) seam.spent.usage = response.usage
      if (response.parts.some(isToolCall)) return failed('the model called a tool instead of writing the summary')
      // only a whole summary replaces the earlier messages: one cut at the output limit, filtered or ended by an error
      // is not taken (the record and its tail stay as they are)
      if (response.finish_reason && INCOMPLETE_SUMMARY.has(response.finish_reason)) return failed(`the summary did not finish (${response.finish_reason})`)
      summary = summaryOf(response.parts.filter(isText).map((p) => p.content).join(''))
      summaryInput = response.usage?.input_tokens ?? null
      modelName = response.model_name ?? null
    } catch (error) {
      // stopped: not a failed summary but the run's end — the loop ends it
      if (seam.ctx?.signal?.aborted) throw error
      if (error instanceof ContextOverflowUnrecovered) throw error
      return failed(`the summary request failed: ${String((error as Error).message ?? error).slice(0, 300)}`)
    }
    if (!summary) return failed('the model returned no summary')
    const bounded = boundedSummary(summary, summaryLimit)
    summary = bounded.text
    const cut = bounded.cut
    const compaction: Compaction = { covers: messages.length, tokens_before: prediction.tokens, summary_input_tokens: summaryInput, model: modelName, at: nowIso() }
    const instructions = tail.instructions ?? seam.instructions
    const personLimit = overflow !== null ? null : Math.floor(this.threshold * PERSON_SHARE)
    // after a refusal for size, the tail's long results (which can be read again) are cut with their note
    let out = [...messages, compactionRequest(view, summary, compaction, instructions, { boundTail: overflow !== null, personLimit })]
    const anchorBefore = this.anchor
    this.anchor = null
    let after = this.predict(withPending(out), seam)
    if (overflow === null && after.tokens > this.window - this.output_reserve) {
      // the results the tail carries whole would leave the next request no room for its output: they are cut too
      out = [...messages, compactionRequest(view, summary, compaction, instructions, { boundTail: true, personLimit })]
      after = this.predict(withPending(out), seam)
    }
    // still no room for the output (the instructions and the tools take more of a small window than the part bound
    // allows for): the tail's long texts are cut shorter, halving down to TAIL_PART_MIN_CHARS, until the request fits
    for (let chars = RECOVERY_PART_CHARS / 2; after.tokens > this.window - this.output_reserve && chars >= TAIL_PART_MIN_CHARS; chars = Math.floor(chars / 2)) {
      out = [...messages, compactionRequest(view, summary, compaction, instructions, { boundTail: true, personLimit, tailChars: chars })]
      after = this.predict(withPending(out), seam)
    }
    if (overflow !== null) {
      // the recovery holds only when the view the provider will read is smaller than the one it refused
      const refused = this.estimateView(messages, seam)
      if (after.tokens >= refused) {
        this.anchor = anchorBefore
        throw new ContextOverflowUnrecovered(`the compacted view (~${after.tokens} tokens) is not smaller than the refused one (~${refused})`)
      }
    }
    // the line moves on the estimate now and on the provider's count of the next request when it comes; after a
    // refusal for size the estimate is known to fall short, so the next compaction is asked at the threshold again
    this.trigger = overflow === null ? this.nextTrigger(after.tokens) : this.threshold
    this.countPending = overflow === null
    return [out, {
      ...base, status: 'compacted', after_tokens: after.tokens, summary_chars: summary.length, summary_input_tokens: summaryInput,
      ...(cut > 0 ? { summary_cut_chars: cut } : {}),
    }]
  }

  /** The estimated tokens of the record's working view with the instructions and the tools (no anchor). */
  private estimateView(messages: ModelMessage[], seam: Pick<RequestSeam, 'instructions' | 'params'>): number {
    const view = workingView(messages)
    const fixed = countTokens(seam.instructions) + countTokens(toolsText(seam.params.function_tools))
    return Math.ceil((fixed + estimateMessages(view, this.fileCost)) * ESTIMATE_FACTOR) + imageCount(view) * IMAGE_TOKENS
  }
}

function toolsText(tools: ToolDefinition[]): string {
  return JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters_json_schema })))
}

/** The summary the model wrote: what its <summary> tags hold — from the first opening tag to the last closing one, so
 *  a summary that names the tags in its own words is kept whole — or all its words. */
export function summaryOf(text: string): string {
  const m = /<summary>([\s\S]*)<\/summary>/i.exec(text)
  return (m ? m[1]! : text).trim()
}

/** The summary held to `limit` tokens (estimated as the keeper estimates; `cut`: the characters left out), unchanged
 *  when it fits. Its lines are kept, the longest shortened first — each to the same length, the rest of it left out
 *  where it stood with a note saying how much — so a short line (a constraint, a decision, where things stand) stays
 *  whole wherever it is in the summary. Only a summary of so many lines that even MIN_LINE_CHARS each would not fit
 *  loses whole lines: its opening and its close kept, the lines between left out with a note. */
export function boundedSummary(summary: string, limit: number): { text: string; cut: number } {
  const measure = (text: string) => Math.ceil(countTokens(text) * ESTIMATE_FACTOR)
  const tokens = measure(summary)
  if (tokens <= limit) return { text: summary, cut: 0 }
  // the characters the limit holds, at the summary's own characters per token; the notes the cuts add are measured
  // with the result, and the room narrowed until it fits
  let room = Math.floor((summary.length * limit) / tokens)
  let best = shortenedLines(summary, room)
  for (let i = 0; i < 4 && measure(best.text) > limit && room > 0; i += 1) {
    room = Math.floor((room * limit) / measure(best.text) * 0.97)
    best = shortenedLines(summary, room)
  }
  return best
}

/** The summary in about `room` characters: every line at most as long as the longest cap that fits (the lines over it
 *  cut with the note), else every line held to MIN_LINE_CHARS and the lines between the opening and the close left out. */
function shortenedLines(summary: string, room: number): { text: string; cut: number } {
  const lines = summary.split('\n')
  const total = summary.length
  const capLine = (line: string, cap: number): [string, number] => (line.length <= cap ? [line, 0]
    : [`${line.slice(0, cap)} ${promptText('compaction.summary_cut', { cut: line.length - cap, total })}`, line.length - cap])
  const capped = (cap: number) => {
    const out = lines.map((line) => capLine(line, cap))
    return { text: out.map(([l]) => l).join('\n'), cut: out.reduce((a, [, c]) => a + c, 0) }
  }
  const longest = Math.max(...lines.map((l) => l.length))
  const floor = capped(Math.min(MIN_LINE_CHARS, longest))
  if (floor.text.length <= room) {
    let lo = Math.min(MIN_LINE_CHARS, longest)
    let hi = longest
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (capped(mid).text.length <= room) lo = mid
      else hi = mid - 1
    }
    return capped(lo)
  }
  // too many lines for any cap: the opening and the close, whole lines of them (each held to MIN_LINE_CHARS)
  const held = lines.map((line) => capLine(line, MIN_LINE_CHARS))
  const half = Math.floor(room / 2)
  let head = 0
  let used = 0
  while (head < held.length && used + held[head]![0].length + 1 <= half) { used += held[head]![0].length + 1; head += 1 }
  let tail = held.length
  used = 0
  while (tail > head && used + held[tail - 1]![0].length + 1 <= half) { used += held[tail - 1]![0].length + 1; tail -= 1 }
  const dropped = lines.slice(head, tail).reduce((a, l) => a + l.length + 1, 0)
  const shortened = [...held.slice(0, head), ...held.slice(tail)].reduce((a, [, c]) => a + c, 0)
  const note = promptText('compaction.summary_cut', { cut: dropped, total })
  return { text: [...held.slice(0, head).map(([l]) => l), note, ...held.slice(tail).map(([l]) => l)].join('\n'), cut: dropped + shortened }
}

/** The view with the parts appended to its last request (the request it ends with is pending: not sent yet). */
function withPrompt(view: ModelMessage[], parts: RequestPart[]): ModelMessage[] {
  const last = view[view.length - 1]!
  if (!isRequest(last)) return [...view, modelRequest(parts, (view.find(isRequest) as ModelRequest | undefined)?.instructions)]
  return [...view.slice(0, -1), { ...last, parts: [...last.parts, ...parts] }]
}

const OMITTED_RETURN = '[omitted from the summary request: the result rides in the compaction request]'

/** A text cut to RECOVERY_PART_CHARS with the note that says how much is shown (unchanged when it fits). */
export function boundedText(text: string, limit = RECOVERY_PART_CHARS): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n${promptText('compaction.cut', { shown: limit, total: text.length })}`
}

function boundedRequestPart(part: RequestPart, limit = RECOVERY_PART_CHARS): RequestPart {
  if (isToolReturn(part)) {
    const text = toolReturnText(part)
    return text.length <= limit ? part : { ...part, content: boundedText(text, limit) }
  }
  if (isUserPrompt(part)) {
    if (typeof part.content === 'string') return { ...part, content: boundedText(part.content, limit) }
    return { ...part, content: part.content.map((c) => (typeof c === 'string' ? boundedText(c, limit) : c)) }
  }
  return part
}

function boundedResponsePart(part: ResponsePart): ResponsePart {
  if (isText(part)) return { ...part, content: boundedText(part.content) }
  return part
}

/** The view for a recovery's summary request: every long text (a tool result, an answer, the app's notes and context,
 *  earlier words of the person) cut with its note — except the person's latest words (the request at `keep`), which
 *  go whole. The record is not touched; the calls stay paired with their returns. */
function boundedView(view: ModelMessage[], keep: Set<number>): ModelMessage[] {
  return view.map((m, i) => (isRequest(m) ? { ...m, parts: m.parts.map((p) => (keep.has(i) || isSteerPart(p) ? boundedButPerson(p) : boundedRequestPart(p))) }
    : isResponse(m) ? { ...m, parts: m.parts.map(boundedResponsePart) } : m))
}

/** How a tool result said again by a compaction opens ("Result of tool call "). */
const TOOL_RESULT_OPENING = PROMPT_TEXT['compaction.tool_result'].split('{')[0]!

/** A text the app wrote, read from the text itself: what a record written before parts kept their origin has. */
function appText(text: string): boolean {
  return text.startsWith('App note') || text.startsWith(TOOL_RESULT_OPENING)
}

/** Which pieces of a user part are the person's own: 'whole' (all of it), the indexes in its list, or null (none).
 *  A part that says its origin is read by it — the app's parts are none of the person's; the person's part is, but
 *  for the pieces it names as the app's (the context the runner puts before the task). A part of an older record
 *  (no origin) is read piece by piece from the text: a piece that opens as an app note or a tool result said again
 *  is the app's, the rest (the task, its images) the person's — never the whole part for its first piece. */
export function personPieces(part: RequestPart): 'whole' | Set<number> | null {
  if (!isUserPrompt(part)) return null
  const origin = part.origin
  if (origin === 'app') return null
  if (typeof part.content === 'string') return origin === 'person' || !appText(part.content) ? 'whole' : null
  const app = new Set(origin === 'person' ? (part.app_pieces ?? []) : [])
  const mine = new Set<number>()
  part.content.forEach((piece, i) => {
    if (app.has(i)) return
    if (typeof piece === 'string') { if ((origin === 'person' || !appText(piece)) && piece.trim()) mine.add(i) }
    else mine.add(i)
  })
  return mine.size ? mine : null
}

/** A user part with the app's long pieces cut (with their note) and the person's pieces whole; any other part bounded. */
function boundedButPerson(part: RequestPart, limit = RECOVERY_PART_CHARS): RequestPart {
  const mine = personPieces(part)
  if (mine === null || !isUserPrompt(part)) return boundedRequestPart(part, limit)
  if (mine === 'whole' || typeof part.content === 'string') return part
  return { ...part, content: part.content.map((piece, i) => (mine.has(i) || typeof piece !== 'string' ? piece : boundedText(piece, limit))) }
}

/** The parts of a request that hold the person's words, as boundedButPerson leaves them (their structure and origin kept). */
function personParts(request: ModelRequest): RequestPart[] {
  return request.parts.filter((p) => personPieces(p) !== null).map((p) => boundedButPerson(p))
}

/** The person's parts held to `limit` tokens (null: whole), unchanged when they fit. Else their words come first: the
 *  images they carried are left out of this copy (the summary was written with them in view), and words that still do
 *  not fit are kept from the start, as much as the limit holds, each piece cut with the note that says how much. */
function personPartsWithin(parts: RequestPart[], limit: number | null): RequestPart[] {
  const sized = (ps: RequestPart[]) => Math.ceil(estimateMessages([modelRequest(ps)]) * ESTIMATE_FACTOR) + imageCount([modelRequest(ps)]) * IMAGE_TOKENS
  if (limit === null || sized(parts) <= limit) return parts
  const words = parts.map((p) => (isUserPrompt(p) ? withoutImages(p) : p))
  const tokens = sized(words)
  if (tokens <= limit) return words
  const chars = words.reduce((a, p) => a + (isUserPrompt(p) ? userText(p).length : 0), 0)
  const marker = (s: string) => s.startsWith('[Attachment ') && s.endsWith('Original bytes/reference remain in history.]')
  const markerTokens = words.reduce((n, p) => n + (isUserPrompt(p) && Array.isArray(p.content) ? p.content.reduce((v: number, c) => v + (typeof c === 'string' && marker(c) ? countTokens(c) : 0), 0) : 0), 0)
  let left = Math.floor((chars * Math.max(0, limit - markerTokens * ESTIMATE_FACTOR - 200)) / tokens)
  const piece = (text: string): string => {
    if (marker(text)) return text
    const shown = Math.max(0, Math.min(text.length, left))
    left -= shown
    return shown === text.length ? text : `${text.slice(0, shown)}\n${promptText('compaction.person_cut', { shown, total: text.length })}`
  }
  return words.map((p) => {
    if (!isUserPrompt(p)) return p
    if (typeof p.content === 'string') return { ...p, content: piece(p.content) }
    return { ...p, content: p.content.map((c) => (typeof c === 'string' ? piece(c) : c)) }
  })
}

/** A user part without its images, the indexes of the app's pieces moved with the pieces that stay. */
function withoutImages(part: UserPromptPart): UserPromptPart {
  if (typeof part.content === 'string') return part
  // a reference (`ref-v1`) stays as it is: a short note where only its path travels, its bytes where the route takes
  // them — the same as in every request before; a legacy file gives way to the marker as it always did
  const kept = part.content.map((piece, i) => [isFilePiece(piece) && !isRefPiece(piece) ? `[Attachment ${JSON.stringify(piece.name)} (${piece.file_kind}) covered by the summary; omitted from this compacted copy to fit context. Original bytes/reference remain in history.]` : piece, i] as const).filter(([piece]) => !isImagePiece(piece))
  if (kept.length === part.content.length && kept.every(([piece], i) => piece === part.content[i])) return part
  const moved = new Map(kept.map(([, i], j) => [i, j]))
  const out: UserPromptPart = { ...part, content: kept.map(([piece]) => piece) }
  if (part.app_pieces) out.app_pieces = part.app_pieces.filter((i) => moved.has(i)).map((i) => moved.get(i)!)
  return out
}

/** The compaction request that follows the record: the summary's note, the person's latest words when the tail does not
 *  hold them (held to `personLimit` tokens; null: whole), then the pending tail said again as text — an earlier
 *  compaction request as the tail without its note (this summary stands for it), and with `boundTail` every long text
 *  of the tail but the person's words cut with its note (a result can be read again) to `tailChars` (default
 *  RECOVERY_PART_CHARS). */
function compactionRequest(view: ModelMessage[], summary: string, compaction: Compaction, instructions: string | null | undefined,
  o: { boundTail: boolean; personLimit: number | null; tailChars?: number }): CompactionRequest {
  const tail = view[view.length - 1] as ModelRequest
  const own = isCompaction(tail) ? tail.parts.slice(1) : tail.parts
  const limit = o.tailChars ?? RECOVERY_PART_CHARS
  const parts = o.boundTail ? own.map((p) => (isToolReturn(p) ? boundedRequestPart(p, limit) : boundedButPerson(p, limit))) : own
  // the person's words of the current turn said before the tail: the turn's opening words (held to personLimit, as
  // ever), and every steer of theirs since — whole, never cut or summarized (the tail's own are said with it, whole)
  const turn = personTurn(view).filter((i) => i !== view.length - 1)
  const opening = turn.length && !(view[turn[0]!] as ModelRequest).parts.every((p) => personPieces(p) === null || isSteerPart(p)) ? turn[0]! : -1
  const words: RequestPart[] = turn.flatMap((i) => {
    const parts = personParts(view[i] as ModelRequest)
    const steers = parts.filter(isSteerPart)
    return i === opening ? [...personPartsWithin(parts.filter((p) => !isSteerPart(p)), o.personLimit), ...steers] : steers
  })
  const carried = words.length ? [userPrompt(promptText('compaction.person_words'), APP_ORIGIN), ...words] : []
  return {
    ...modelRequest([userPrompt(promptText('compaction.note', { summary }), APP_ORIGIN), ...carried, ...tailAsUserParts({ ...tail, parts })], instructions),
    compaction,
  }
}

/** The indexes in the view of the requests that hold the person's words of the current turn: the last request with
 *  words of theirs that are not a steer (the turn's opening: the run's message, or a compaction that carried it), then
 *  every later request that holds a steer of theirs — or, with no opening in view, every request holding a steer.
 *  Words of earlier turns are the record's history, which a summary may stand for; these are not. */
export function personTurn(view: ModelMessage[]): number[] {
  let opening = -1
  for (let i = view.length - 1; i >= 0 && opening === -1; i -= 1) {
    const m = view[i]!
    if (isRequest(m) && m.parts.some((p) => personPieces(p) !== null && !isSteerPart(p))) opening = i
  }
  const out: number[] = opening >= 0 ? [opening] : []
  for (let i = opening + 1; i < view.length; i += 1) {
    const m = view[i]!
    if (isRequest(m) && m.parts.some(isSteerPart)) out.push(i)
  }
  return out
}

/** The view with the last request's tool returns replaced by a short note (the calls stay answered). */
function withReturnsOmitted(view: ModelMessage[]): ModelMessage[] {
  const last = view[view.length - 1]!
  if (!isRequest(last)) return view
  const parts: RequestPart[] = last.parts.map((p) => (isToolReturn(p) ? { ...p, content: OMITTED_RETURN } : p))
  return [...view.slice(0, -1), { ...last, parts }]
}

/** The pending tail said again as user parts: the person's words and system notes as they are (their images
 *  with them), a tool result as text under the call it answers — with the images the result carried. */
export function tailAsUserParts(tail: ModelRequest): RequestPart[] {
  const out: RequestPart[] = []
  for (const part of tail.parts) {
    if (isToolReturn(part)) {
      const images = returnHasImage(part.content) ? Object.values(part.content).filter(isImagePiece) : []
      const body = promptText('compaction.tool_result', { id: part.tool_call_id, tool: part.tool_name, content: toolReturnText(part) })
      const content: UserContent = images.length ? [body, ...images] : body
      out.push(userPrompt(content, APP_ORIGIN))
    } else if (isRetryPrompt(part)) {
      out.push(userPrompt(promptText('compaction.tool_result', { id: part.tool_call_id ?? '', tool: part.tool_name ?? 'tool', content: retryText(part) }), APP_ORIGIN))
    } else {
      out.push(part)
    }
  }
  return out
}
