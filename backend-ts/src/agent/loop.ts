/** The agent loop: instructions, tools, a model — and the two seams the runner hangs on: a history processor called
 *  before every request (harness notes, the context keeper's compaction, the crash stash) with the request about to
 *  be made and what the provider counted for the last one, and a per-request tool selection (the run's visible
 *  surface). The message list is a record: the loop appends responses and requests and never rewrites one. One
 *  request at a time; tool calls run in order; a tool's ModelRetry or a bad argument becomes a retry prompt the
 *  model reads; the usage limits stop the loop; a cancelled token ends it at the next boundary. */

import {
  answerText, APP_ORIGIN, argsDict, argsProblem, emptyUsage, isRequest, isText, isToolCall, modelRequest, retryPrompt, toolReturn, userPrompt, type ModelMessage, type ModelRequest, type ModelResponse,
  type PromptOrigin, type RequestPart, type ToolCallPart, type UserContent,
} from '../llm/messages.ts'
import {
  CancellationToken, ModelRetry, RunCancelled, UnexpectedModelBehavior, UsageLimitExceeded, addUsage, pastLongDecodeCheckpoint, type BuiltinTool, type JsonSchema, type Model,
  type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamEvent, type ToolDefinition, type UsageLimits,
} from '../llm/model.ts'
import type { RequestUsage } from '../llm/messages.ts'
import { PROMPT_TEXT } from '../prompt_texts.ts'

/** How many times an answer cut off at the output limit is asked for its rest, in one segment. */
export const OUTPUT_LIMIT_CONTINUATIONS = 2
/** How many times a response with no answer text (empty, reasoning only, or ended by a provider error) is asked again. */
export const EMPTY_ANSWER_RETRIES = 1
/** How many times a turn the provider paused in its own tools' loop (`pause_turn`) is resumed, in one segment. */
export const PAUSED_TURN_RESUMES = 3

/** How an answer ended when it did not end normally: cut at the output limit (and the continuations spent), ended
 *  with no answer text, stopped by the provider's filter or refusal, or ended by a provider error. */
export interface AnswerEnd {
  reason: 'length' | 'no_final_output' | 'content_filter' | 'provider_error'
  attempts: number
}

export interface ToolContext<D> {
  deps: D
  tool_call_id: string
  tool_name: string
  retry: number
  messages: ModelMessage[]
}

export interface Tool<D> {
  name: string
  description: string
  parameters_json_schema: JsonSchema
  /** The arguments validated: a value to call the tool with, or the error the model reads as a retry prompt. */
  validate: (args: unknown) => { value: unknown } | { error: string }
  fn: (ctx: ToolContext<D>, args: never) => Promise<unknown> | unknown
}

/** What the provider counted for a request that went out, and how long the message list was when it did. */
export interface ContextAnchor {
  input_tokens: number
  messages: number
}

/** The request about to be made, as the history processor sees it: the model (through every wrapper), the settings
 *  and parameters it will carry, the instructions, and the provider's count of the last request when one went out
 *  since the processor was last called. */
export interface RequestSeam {
  model: Model
  settings: ModelSettings
  params: ModelRequestParameters
  instructions: string
  observed: ContextAnchor | null
  /** the run's request context (its Stop): a request the processor makes itself is cancelled with the run (the loop
   *  always gives it; a seam built elsewhere may not) */
  ctx?: RequestContext
  /** the requests the processor made itself (a summary), and their usage: they count toward the run's limits as the
   *  loop's own do */
  spent?: { requests: number; usage: RequestUsage }
  /** the requests the segment (and so the run's budget) has left before this one is made (null: no line) */
  requests_left?: number | null
}

export interface AgentConfig<D> {
  instructions: string
  tools: Tool<D>[]
  /** Called before every request with the whole history and the request about to be made; what it returns is the
   *  history from then on (appended to, never rewritten). */
  processHistory?: (deps: D, messages: ModelMessage[], seam: RequestSeam) => ModelMessage[] | Promise<ModelMessage[]>
  /** Called with the whole history whenever it grew: a response accepted, a tool's return in hand (the returns of
   *  a response's calls so far as one request), so a stop or a crash between requests keeps what happened. */
  onMessages?: (deps: D, messages: ModelMessage[]) => void
  /** Which tool definitions this request carries. */
  prepareTools?: (deps: D, defs: ToolDefinition[]) => ToolDefinition[]
  /** Which of the tools the provider runs itself this request declares, for this model (given the definitions it
   *  carries); a provider tool takes the place of the harness's tool of the same name. */
  builtinTools?: (deps: D, model: Model, defs: ToolDefinition[]) => BuiltinTool[]
  /** The last say on a request about to be made (main, continuation, or a summary the history processor makes on its
   *  seam), after the tools are chosen: the instructions and parameters it goes with, or a throw that refuses it before
   *  anything is sent. `offered` is the function list before a provider tool took its namesake's place. */
  prepareRequest?: (deps: D, model: Model, req: { instructions: string; params: ModelRequestParameters; offered: ToolDefinition[] }) => { instructions: string; params: ModelRequestParameters }
  /** The person's words sent while the run works (in-run steering): handed at request boundaries only — never into a
   *  request already sent, never between a response's tool calls and their returns. */
  input?: InputSeam<D>
  retries?: number
}

/** The loop's view of in-run steering (agent/steering.ts is the runner's side). */
export interface InputSeam<D> {
  /** words wait for the next boundary (a final answer that finds some goes on in the same run) */
  pending(deps: D): boolean
  /** right before a request: the messages with the waiting words appended to the pending request they end with, and
   *  committed; the same messages when none go. `must`: decide every waiting steer now (none is left for later). */
  deliver(deps: D, messages: ModelMessage[], seam: RequestSeam, must: boolean): ModelMessage[]
  /** the run's end is decided: no more words are taken (called in the same tick as the last `pending`) */
  close(deps: D): void
}

export interface RunUsage extends RequestUsage {
  requests: number
  tool_calls: number
}

export interface AgentRunResult {
  output: string
  /** null: the answer ended normally (a stop with answer text) */
  incomplete: AnswerEnd | null
  usage: RunUsage
  allMessages(): ModelMessage[]
  allMessagesJson(): string
}

/** The text a model had streamed when its request failed, by the failure (see partialTextOf). */
const PARTIAL_TEXT = new WeakMap<object, string>()

/** The answer's words that arrived before this failure broke the stream, or null. */
export function partialTextOf(error: unknown): string | null {
  return typeof error === 'object' && error !== null ? (PARTIAL_TEXT.get(error) ?? null) : null
}

/** The run stopped after this failure (while waiting to recover from it, say): a stop, carrying the words the
 *  failure had kept. */
export function stoppedAfter(error: unknown): RunCancelled {
  const stopped = new RunCancelled()
  const partial = partialTextOf(error)
  if (partial !== null) PARTIAL_TEXT.set(stopped, partial)
  return stopped
}

export type AgentEvent =
  | StreamEvent
  | { type: 'tool_call'; part: ToolCallPart }
  /** a call of the accepted response answered as cancelled: the tool the stop came under, or one it came before */
  | { type: 'tool_cancelled'; part: ToolCallPart; reason: string }
  | { type: 'result'; result: AgentRunResult }
  /** the answer did not end normally and one more request asks for it (its words so far stay in the record) */
  | { type: 'continued'; reason: 'output_limit' | 'no_answer' | 'paused'; attempt: number; of: number; kept_chars: number; finish_reason: string | null }
  /** the answer so far is a step: the person's words that came while it formed go next (the stream's answer row
   *  closes here, before they are said delivered) */
  | { type: 'step_end' }

/** What a call answers with when the run is stopped before it starts: it was not executed, and never is later. */
export const NOT_STARTED_REASON = 'not executed: the run was stopped before this tool call started'
/** What a call answers with when an earlier call of the same response halted the run: it was not executed. */
export const HALTED_BEFORE_REASON = 'not executed: an earlier call of this response stopped the run (an effect whose outcome is unknown); nothing after it ran'

/** A tool that must stop the run where it stands — an effect whose outcome is unknown, where any further step could
 *  act on a false belief: its `result` is recorded as its return, every later call of the same response is answered
 *  as not executed, and the run ends before any further request or tool. */
export class RunHalted extends Error {
  constructor(readonly result: Record<string, unknown>, readonly reason: string) { super(reason); this.name = 'RunHalted' }
}
const STOPPED_UNDER_REASON = 'the run was stopped while this tool ran; its effect may or may not have reached the workspace — check before relying on it'

export interface RunOptions<D> {
  /** the person's words, or words and structured pieces (an attached image's reference) */
  prompt: UserContent | null
  /** who wrote the prompt (absent: not said) */
  promptOrigin?: PromptOrigin
  deps: D
  model: Model
  modelSettings?: ModelSettings
  messageHistory?: ModelMessage[] | null
  usageLimits?: UsageLimits
  token?: CancellationToken
  /** the first request of this call continues a cut-off answer: no steer joins it (the next boundary takes them) */
  holdInput?: boolean
}

export class Agent<D> {
  readonly instructions: string
  readonly tools: Map<string, Tool<D>>
  readonly retries: number
  private readonly processHistory?: AgentConfig<D>['processHistory']
  private readonly prepareTools?: AgentConfig<D>['prepareTools']
  private readonly builtinTools?: AgentConfig<D>['builtinTools']
  private readonly prepareRequest?: AgentConfig<D>['prepareRequest']
  private readonly onMessages?: AgentConfig<D>['onMessages']
  private readonly input?: AgentConfig<D>['input']

  constructor(config: AgentConfig<D>) {
    this.instructions = config.instructions
    this.tools = new Map(config.tools.map((t) => [t.name, t]))
    this.retries = config.retries ?? 1
    this.processHistory = config.processHistory
    this.prepareTools = config.prepareTools
    this.builtinTools = config.builtinTools
    this.prepareRequest = config.prepareRequest
    this.onMessages = config.onMessages
    this.input = config.input
  }

  toolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters_json_schema: t.parameters_json_schema }))
  }

  /** The loop as events; the last one carries the result. */
  async *runStreamEvents(opts: RunOptions<D>): AsyncGenerator<AgentEvent, void, undefined> {
    const token = opts.token ?? new CancellationToken()
    const settings = opts.modelSettings ?? {}
    const limits = opts.usageLimits ?? {}
    let messages = this.startingMessages(opts.prompt, opts.messageHistory ?? null, opts.promptOrigin)
    const usage: RunUsage = { requests: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
    const retryCounts = new Map<string, number>()
    let output = ''
    let incomplete: AnswerEnd | null = null
    let continuations = 0
    let emptyRetries = 0
    let resumes = 0
    // the words of responses the provider paused (its own tools' loop cut short) that the resumed one goes on from
    let pausedWords = ''
    let observed: ContextAnchor | null = null
    // the next request continues an answer (cut off, empty, or a broken stream's kept words): no steer joins it
    let holdInput = opts.holdInput === true
    // the messages end with the request a final answer opened for the steers that came while it formed; the answer
    // it would have been, should none of them go
    let openedForInput = false
    let answerBefore = ''

    // the token line holds before every request the loop makes or lets be made (a summary's included), not only after
    // a response: a segment that starts with the budget spent, or a summary that spent it, makes no request
    const tokensSpent = (): void => {
      const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      if (limits.total_tokens_limit != null && total >= limits.total_tokens_limit) {
        throw new UsageLimitExceeded(`The next request would exceed the total_tokens_limit of ${limits.total_tokens_limit} (${total} spent)`)
      }
    }

    for (;;) {
      if (token.cancelled) throw new RunCancelled()
      tokensSpent()
      let defs = this.toolDefinitions()
      if (this.prepareTools) defs = this.prepareTools(opts.deps, defs)
      const offeredDefs = defs
      const offered = new Set(opts.model.profile.builtin_tools ?? [])
      const builtin = (this.builtinTools ? this.builtinTools(opts.deps, opts.model, defs) : []).filter((t) => offered.has(t.kind))
      // the provider's own tool stands where the harness's of the same name would (a request cannot carry both)
      if (builtin.length) defs = defs.filter((d) => !builtin.some((b) => b.kind === d.name))
      let params: ModelRequestParameters = {
        function_tools: defs, allow_text_output: true,
        thinking: opts.model.profile.supports_thinking ? (settings.thinking ?? null) : null,
        ...(builtin.length ? { builtin_tools: builtin } : {}),
      }
      let instructions = this.instructions
      if (this.prepareRequest) {
        // decided before anything goes out (a summary included); what it returns is what the seam and the request carry
        const decided = this.prepareRequest(opts.deps, opts.model, { instructions, params, offered: offeredDefs })
        instructions = decided.instructions
        params = decided.params
        // the pending request (never sent) carries the decided instructions: the provider reads the last request's
        const pending = messages[messages.length - 1]
        if (pending !== undefined && isRequest(pending) && pending.instructions !== instructions) messages = [...messages.slice(0, -1), { ...pending, instructions }]
      }
      const left = limits.request_limit != null ? limits.request_limit - usage.requests : null
      const seam: RequestSeam = { model: opts.model, settings, params, instructions, observed, ctx: { signal: token.signal }, spent: { requests: 0, usage: emptyUsage() }, requests_left: left }
      if (this.processHistory) {
        try {
          messages = await this.processHistory(opts.deps, messages, seam)
        } catch (e) {
          // a summary cut off by the Stop ends the run as stopped, not as failed
          if (token.cancelled) throw new RunCancelled()
          throw e
        }
        observed = null
        // a summary the processor asked for is a request like any other: the segment's line (and so the budget's) counts it
        const spent = seam.spent!
        usage.requests += spent.requests
        if (spent.requests) Object.assign(usage, addUsage(usage, spent.usage))
        if (token.cancelled) throw new RunCancelled()
      }
      if (limits.request_limit != null && usage.requests + 1 > limits.request_limit) {
        throw new UsageLimitExceeded(`The next request would exceed the request_limit of ${limits.request_limit}`)
      }
      tokensSpent()
      // the person's words that came while the run worked join the request about to go — the pending one, never one
      // a provider has seen, after every return of the response before it — and are committed with it; a request
      // that continues an answer takes none (the next boundary does)
      const tail = messages[messages.length - 1]
      if (this.input && !holdInput && !token.cancelled && tail !== undefined && isRequest(tail)) {
        const before = messages
        messages = this.input.deliver(opts.deps, messages, seam, openedForInput)
        if (openedForInput && messages === before) {
          // none of them could go: the answer stands as it was, and the run takes no more words
          openedForInput = false
          if (tail.parts.length === 0) messages = messages.slice(0, -1)
          this.input.close(opts.deps)
          output = answerBefore
          break
        }
      }
      holdInput = false
      openedForInput = false
      const sent = messages.length
      let stream
      try {
        stream = await opts.model.requestStream(messages, settings, params, { signal: token.signal })
        for await (const event of stream.events()) yield event
      } catch (e) {
        // a stream that broke mid-answer (or was stopped): the words that did arrive go with the failure, so a
        // recovery can keep them and ask for the rest instead of the whole answer again, and a stopped run keeps
        // what was shown (reasoning and half-written tool calls cannot resume)
        const failure = token.cancelled ? new RunCancelled() : e
        if (stream !== undefined && typeof failure === 'object' && failure !== null) {
          let partial = ''
          try { partial = stream.get().parts.filter(isText).map((p) => p.content).join('') } catch { partial = '' }
          if (partial.trim()) PARTIAL_TEXT.set(failure, partial)
        }
        throw failure
      }
      const response = uniqueCallIds(stream.get(), messages)
      usage.requests += 1
      Object.assign(usage, addUsage(usage, response.usage))
      observed = { input_tokens: response.usage?.input_tokens ?? 0, messages: sent }
      const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      if (limits.total_tokens_limit != null && total > limits.total_tokens_limit) {
        messages = [...messages, response]
        throw new UsageLimitExceeded(`Exceeded the total_tokens_limit of ${limits.total_tokens_limit} (${total})`)
      }
      messages = [...messages, response]
      this.onMessages?.(opts.deps, messages)
      const calls = response.parts.filter(isToolCall)
      if (calls.length === 0) {
        // how the answer ended decides whether it is the answer: a normal stop with words is; words cut at the output
        // limit are asked for their rest, a response without words (or ended by a provider error) is asked once more —
        // each a request like any other, bounded, and only while the request line leaves room; a filter or refusal
        // is taken as it is. The record keeps every response as it came; the words are never judged by what they say.
        output = pausedWords + answerText(response.parts)
        const finish = response.finish_reason ?? null
        const room = limits.request_limit == null || usage.requests + 1 <= limits.request_limit
        const hasWords = output.trim() !== ''
        if (finish === 'content_filter') { incomplete = { reason: 'content_filter', attempts: 0 }; break }
        if (finish === 'pause_turn' && resumes < PAUSED_TURN_RESUMES && room && !token.cancelled) {
          // the provider stopped its own tools' loop partway (its search, say): the same turn goes on from the paused
          // response, with no word of the harness's in between (the provider resumes from its own last block)
          resumes += 1
          pausedWords = output
          yield { type: 'continued', reason: 'paused', attempt: resumes, of: PAUSED_TURN_RESUMES, kept_chars: output.length, finish_reason: finish }
          continue
        }
        if (pastLongDecodeCheckpoint(response) && (finish === 'length' || finish === 'error' || !hasWords)) {
          // a long decode (Gemini 4 Argon) past its checkpoints that ended at its output total, with the provider's
          // failure or without words: asking again would be a whole new request without the continuation token — every
          // token thought (and billed) again from the start. The answer ends here, said as such (not a disconnect)
          incomplete = { reason: finish === 'error' ? 'provider_error' : finish === 'length' ? 'length' : 'no_final_output', attempts: 0 }
          break
        }
        if (finish === 'length' && hasWords) {
          if (continuations < OUTPUT_LIMIT_CONTINUATIONS && room && !token.cancelled) {
            continuations += 1
            messages = [...messages, modelRequest([userPrompt(`${PROMPT_TEXT['app.output_limit']} ${PROMPT_TEXT['app.cut_off']}`, APP_ORIGIN)], this.instructions)]
            holdInput = true
            this.onMessages?.(opts.deps, messages)
            yield { type: 'continued', reason: 'output_limit', attempt: continuations, of: OUTPUT_LIMIT_CONTINUATIONS, kept_chars: output.length, finish_reason: finish }
            continue
          }
          incomplete = { reason: 'length', attempts: continuations }
          break
        }
        if (!hasWords || finish === 'error') {
          if (emptyRetries < EMPTY_ANSWER_RETRIES && room && !token.cancelled) {
            emptyRetries += 1
            messages = [...messages, modelRequest([userPrompt(PROMPT_TEXT['app.no_answer'], APP_ORIGIN)], this.instructions)]
            holdInput = true
            this.onMessages?.(opts.deps, messages)
            yield { type: 'continued', reason: 'no_answer', attempt: emptyRetries, of: EMPTY_ANSWER_RETRIES, kept_chars: 0, finish_reason: finish }
            continue
          }
          incomplete = { reason: finish === 'error' ? 'provider_error' : finish === 'length' ? 'length' : 'no_final_output', attempts: emptyRetries }
          break
        }
        // the answer is whole: words the person sent while it formed make it a step, not the end — the run goes on in
        // a request of their own (Codex's follow-up on pending input); none waiting, the end is decided here, in the
        // same tick as the look, so no word is taken after it and then lost
        if (this.input && room && !token.cancelled && this.input.pending(opts.deps)) {
          openedForInput = true
          answerBefore = output
          pausedWords = ''
          messages = [...messages, modelRequest([], this.instructions)]
          yield { type: 'step_end' }
          continue
        }
        break
      }
      const parts: RequestPart[] = []
      const pending = [...calls]
      // a response cut at the output limit ends inside its last call: those arguments are a fragment, said as such
      const cut = response.finish_reason === 'length' ? calls[calls.length - 1] : undefined
      let stopped = false
      while (pending.length) {
        const call = pending[0]!
        // stopped before this call: it is not started (and answered as such below), the returns in hand are kept
        if (token.cancelled) { stopped = true; break }
        pending.shift()
        yield { type: 'tool_call', part: call }
        const tool = this.tools.get(call.tool_name)
        const visible = defs.some((d) => d.name === call.tool_name)
        if (!tool || !visible) {
          const names = defs.map((d) => d.name).join(', ')
          const unknownRetry = retryCounts.get(call.tool_name) ?? 0
          if (unknownRetry + 1 > this.retries) throw new UnexpectedModelBehavior(`Tool '${call.tool_name}' exceeded max retries count of ${this.retries} (it is not among this run's tools)`)
          retryCounts.set(call.tool_name, unknownRetry + 1)
          parts.push(retryPrompt(`Unknown tool name: '${call.tool_name}'. Available tools: ${names}`, call.tool_name, call.tool_call_id))
          continue
        }
        if (limits.tool_calls_limit != null && usage.tool_calls + 1 > limits.tool_calls_limit) {
          throw new UsageLimitExceeded(`The next tool call would exceed the tool_calls_limit of ${limits.tool_calls_limit}`)
        }
        if (call === cut) {
          const retry = retryCounts.get(call.tool_name) ?? 0
          if (retry + 1 > this.retries) throw new UnexpectedModelBehavior(`Tool '${call.tool_name}' exceeded max retries count of ${this.retries} (its arguments were cut at the output limit)`)
          retryCounts.set(call.tool_name, retry + 1)
          const written = typeof call.args === 'string' ? call.args.length : JSON.stringify(call.args ?? '').length
          parts.push(retryPrompt(PROMPT_TEXT['app.call_cut'].replace('{chars}', String(written)), call.tool_name, call.tool_call_id))
          continue
        }
        // arguments that are not a JSON object are said as such (the parser's reason), not validated as an empty object
        // a provider that could not decode a call's arguments says why (provider_details.args_problem); it is not run
        const declared = (call.provider_details as { args_problem?: unknown } | null | undefined)?.args_problem
        const problem = typeof declared === 'string' ? declared : argsProblem(call.args)
        const validated: { value: unknown } | { error: string } = problem !== null ? { error: problem } : tool.validate(call.args === null || call.args === undefined ? {} : argsDict(call.args))
        const retry = retryCounts.get(call.tool_name) ?? 0
        if ('error' in validated) {
          if (retry + 1 > this.retries) throw new UnexpectedModelBehavior(`Tool '${call.tool_name}' exceeded max retries count of ${this.retries}`)
          retryCounts.set(call.tool_name, retry + 1)
          parts.push(retryPrompt(validated.error, call.tool_name, call.tool_call_id))
          continue
        }
        const ctx: ToolContext<D> = { deps: opts.deps, tool_call_id: call.tool_call_id, tool_name: call.tool_name, retry, messages }
        let result: unknown
        try {
          result = await tool.fn(ctx, validated.value as never)
        } catch (e) {
          if (e instanceof ModelRetry) {
            if (retry + 1 > this.retries) throw new UnexpectedModelBehavior(`Tool '${call.tool_name}' exceeded max retries count of ${this.retries}`)
            retryCounts.set(call.tool_name, retry + 1)
            parts.push(retryPrompt(e.message, call.tool_name, call.tool_call_id))
            continue
          }
          if (e instanceof RunHalted) {
            // the record pairs every call: the halting tool's own answer, then "not executed" for each call after it;
            // nothing more runs and no request follows (the runner ends the run with the reason)
            usage.tool_calls += 1
            parts.push(toolReturn(call.tool_name, e.result, call.tool_call_id))
            for (const rest of pending) {
              parts.push(toolReturn(rest.tool_name, { status: 'cancelled', reason: HALTED_BEFORE_REASON }, rest.tool_call_id))
              yield { type: 'tool_cancelled', part: rest, reason: HALTED_BEFORE_REASON }
            }
            messages = [...messages, modelRequest(parts, this.instructions)]
            this.onMessages?.(opts.deps, messages)
            throw e
          }
          if (token.cancelled) {
            // a tool that broke because the run was stopped under it: recorded as a stopped call, never as its own error
            parts.push(toolReturn(call.tool_name, { status: 'cancelled', reason: STOPPED_UNDER_REASON }, call.tool_call_id))
            yield { type: 'tool_cancelled', part: call, reason: STOPPED_UNDER_REASON }
            stopped = true
            break
          }
          throw e
        }
        retryCounts.delete(call.tool_name)
        usage.tool_calls += 1
        parts.push(toolReturn(call.tool_name, result, call.tool_call_id))
        // the return is in hand: the record knows it even if the next moment is a stop or a crash
        this.onMessages?.(opts.deps, [...messages, modelRequest(parts, this.instructions)])
      }
      if (stopped) {
        // the record pairs every call of the response — the returns in hand, the stopped tool's, and "not started"
        // for each call the stop came before — so the run's own transcript and the next model read what happened,
        // and nothing is run later on the model's behalf
        for (const call of pending) {
          parts.push(toolReturn(call.tool_name, { status: 'cancelled', reason: NOT_STARTED_REASON }, call.tool_call_id))
          yield { type: 'tool_cancelled', part: call, reason: NOT_STARTED_REASON }
        }
        messages = [...messages, modelRequest(parts, this.instructions)]
        this.onMessages?.(opts.deps, messages)
        throw new RunCancelled()
      }
      messages = [...messages, modelRequest(parts, this.instructions)]
      this.onMessages?.(opts.deps, messages)
    }
    // the loop ends here only with its end decided: the run takes no more words
    this.input?.close(opts.deps)
    const finalMessages = messages
    const result: AgentRunResult = {
      output, incomplete, usage, allMessages: () => finalMessages, allMessagesJson: () => JSON.stringify(finalMessages),
    }
    yield { type: 'result', result }
  }

  /** The history plus the new prompt: appended to the last request when the history ends with one (a closing
   *  request of dangling tool calls, a note, a compaction whose request never went out), else a new request; the
   *  last request always carries these instructions. A request that ends a history was never sent (a sent request
   *  is followed by its response), so extending it rewrites nothing a provider has seen. */
  private startingMessages(prompt: UserContent | null, history: ModelMessage[] | null, origin?: PromptOrigin): ModelMessage[] {
    const messages = [...(history ?? [])]
    const last = messages[messages.length - 1]
    if (last && isRequest(last)) {
      const parts = prompt !== null ? [...last.parts, userPrompt(prompt, origin)] : last.parts
      messages[messages.length - 1] = { ...last, parts, instructions: this.instructions } as ModelRequest
      return messages
    }
    if (prompt === null) throw new Error('nothing to send: no prompt and the history does not end with a request')
    messages.push(modelRequest([userPrompt(prompt, origin)], this.instructions))
    return messages
  }
}

/** A response whose tool calls reuse an id — of each other, or of a call earlier in the conversation — has the later
 *  ones renamed (`<id>_2`, …, a form every provider takes): each call then has its own return, on the wire and in the
 *  transcript, and a result can never be taken for another call's. The first call keeps the provider's id. */
export function uniqueCallIds(response: ModelResponse, history: ModelMessage[]): ModelResponse {
  const taken = new Set<string>()
  for (const m of history) if (!isRequest(m)) for (const p of m.parts) if (isToolCall(p)) taken.add(p.tool_call_id)
  let renamed = false
  const parts = response.parts.map((p) => {
    if (!isToolCall(p)) return p
    if (!taken.has(p.tool_call_id)) { taken.add(p.tool_call_id); return p }
    let n = 2
    while (taken.has(`${p.tool_call_id}_${n}`)) n += 1
    const id = `${p.tool_call_id}_${n}`
    taken.add(id)
    renamed = true
    return { ...p, tool_call_id: id }
  })
  return renamed ? { ...response, parts } : response
}
