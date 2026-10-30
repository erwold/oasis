/**
 * Safe, opt-in Antigravity tool/stream probe. Import and dry-run never access credentials.
 *   bun run scripts/antigravity_probe.ts
 *   bun run scripts/antigravity_probe.ts --live --auth-dir /absolute/private/auth --route antigravity:MODEL --thinking medium
 * All registered tools are declared; only a bounded read of this probe's own temporary fixture executes.
 * Each route makes at most two inference requests, with the production adapter and no host fallback.
 * Output contains counts, allowlisted protocol structure and settings; never raw requests, responses or errors.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { buildAgent } from '../src/agent/agent.ts'
import { SUPPORTED_MODELS } from '../src/auth/antigravity_catalog.ts'
import type { GrantSource } from '../src/auth/models.ts'
import { CONTROL_ENDPOINTS, isRecord } from '../src/auth/oauth_antigravity.ts'
import { NativeAuthError, NativeAuthTemporaryError, tokenManager } from '../src/auth/store.ts'
import { answerText, argsDict, isToolCall, modelRequest, toolReturn, userPrompt, type ModelMessage, type ModelResponse } from '../src/llm/messages.ts'
import { ModelAPIError, ModelHTTPError, TransportError, type ModelRequestParameters, type StreamEvent } from '../src/llm/model.ts'
import type { FetchLike } from '../src/llm/http.ts'
import { AntigravityModel, STREAM_URL } from '../src/llm/providers/antigravity.ts'
import { AntigravityCarrierError } from '../src/llm/providers/antigravity_schema.ts'
import { toolSchemaFingerprint } from '../src/llm/usage.ts'
import { safeFetch } from '../src/safe_fetch.ts'

export type ProbeThinking = 'default' | 'low' | 'medium' | 'high'
type Stage = 'prepare' | 'first_request' | 'tool_validation' | 'continuation_request' | 'continuation_validation'
class ProbeContractError extends Error {}
const finishReasons = new Set(['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'CONTINUATION'])
const envelopeKeys = ['response', 'error', 'responseId', 'modelVersion', 'candidates', 'usageMetadata', 'promptFeedback', 'traceId', 'modelStatus']
const candidateKeys = ['content', 'finishReason', 'index', 'safetyRatings', 'citationMetadata', 'groundingMetadata', 'avgLogprobs', 'logprobsResult']
const partKeys = ['text', 'thought', 'thoughtSignature', 'functionCall', 'functionResponse', 'inlineData', 'fileData', 'executableCode', 'codeExecutionResult']
const MAX_FRAME_CHARS = 1_048_576

/** Unknown field NAMES are not emitted: even an unexpected key can contain account data or a secret. */
function safeKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(value)
  return { keys: allowed.filter(k => Object.hasOwn(value, k)), unknown_keys: keys.filter(k => !allowed.includes(k)).length }
}
export interface SseDiagnostics {
  bytes: number
  frames: number
  done_frames: number
  invalid_json_frames: number
  non_object_frames: number
  oversized_frames: number
  candidates: number
  text_parts: number
  thought_parts: number
  tool_calls: number
  signatures: number
  error_frames: number
  prompt_block_frames: number
  complete: boolean
  finish_reasons: Record<string, number>
  structures: { count: number; envelope: ReturnType<typeof safeKeys>; response: ReturnType<typeof safeKeys> | null; candidates: ReturnType<typeof safeKeys>[]; parts: ReturnType<typeof safeKeys>[] }[]
  omitted_structures: number
}
function newSseDiagnostics(): SseDiagnostics {
  return { bytes: 0, frames: 0, done_frames: 0, invalid_json_frames: 0, non_object_frames: 0, oversized_frames: 0, candidates: 0, text_parts: 0, thought_parts: 0, tool_calls: 0, signatures: 0, error_frames: 0, prompt_block_frames: 0, complete: false, finish_reasons: {}, structures: [], omitted_structures: 0 }
}

/** Observe bytes as the production adapter consumes them; no tee, eager buffering or extra HTTP request. */
export class SafeSseObserver {
  readonly result = newSseDiagnostics()
  private decoder = new TextDecoder()
  private line = ''
  private data: string[] = []
  private dataSize = 0
  private oversized = false
  private event = false
  private lineHasContent = false
  feed(bytes: Uint8Array): void {
    this.result.bytes += bytes.byteLength
    this.consume(this.decoder.decode(bytes, { stream: true }))
  }
  private consume(text: string): void {
    for (const piece of text.split(/(?<=\n)/)) {
      if (!piece) continue
      this.lineHasContent ||= /[^\r\n]/.test(piece)
      if (!this.oversized) {
        this.line += piece
        if (this.line.length + this.dataSize > MAX_FRAME_CHARS) { this.oversized = true; this.line = ''; this.data = [] }
      }
      if (piece.endsWith('\n')) {
        // Once oversized, retain only enough framing state to find the next blank line.
        if (this.oversized) { if (!this.lineHasContent) this.flush() }
        else { this.consumeLine(this.line.replace(/\r?\n$/, '')); this.line = '' }
        this.lineHasContent = false
      }
    }
  }
  private consumeLine(line: string): void {
    if (line === '') { this.flush(); return }
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '')
      this.data.push(value); this.dataSize += line.length + 1
    } else if (line.startsWith('event:')) this.event = true
  }
  private flush(): void {
    if (this.oversized) { this.result.frames++; this.result.oversized_frames++ }
    else if (this.data.length || this.event) {
      this.result.frames++
      const text = this.data.join('\n')
      if (text === '[DONE]') this.result.done_frames++
      else if (text) this.inspect(text)
    }
    this.data = []; this.dataSize = 0; this.oversized = false; this.event = false; this.line = ''; this.lineHasContent = false
  }
  private inspect(text: string): void {
    let value: unknown
    try { value = JSON.parse(text) } catch { this.result.invalid_json_frames++; return }
    if (!isRecord(value)) { this.result.non_object_frames++; return }
    const data = isRecord(value.response) ? value.response : value
    if (value.error || data.error) this.result.error_frames++
    if (isRecord(data.promptFeedback) && data.promptFeedback.blockReason) this.result.prompt_block_frames++
    const candidates = Array.isArray(data.candidates) ? data.candidates.filter(isRecord) : []
    this.result.candidates += candidates.length
    const parts = candidates.flatMap(c => isRecord(c.content) && Array.isArray(c.content.parts) ? c.content.parts.filter(isRecord) : [])
    for (const c of candidates) if (c.finishReason) {
      const reason = typeof c.finishReason === 'string' && finishReasons.has(c.finishReason) ? c.finishReason : 'unknown'
      this.result.finish_reasons[reason] = (this.result.finish_reasons[reason] ?? 0) + 1
    }
    for (const p of parts) {
      if (typeof p.text === 'string') p.thought === true ? this.result.thought_parts++ : this.result.text_parts++
      if (isRecord(p.functionCall)) this.result.tool_calls++
      if (typeof p.thoughtSignature === 'string') this.result.signatures++
    }
    const structure = { envelope: safeKeys(value, envelopeKeys), response: data === value ? null : safeKeys(data, envelopeKeys), candidates: candidates.slice(0, 8).map(c => safeKeys(c, candidateKeys)), parts: parts.slice(0, 16).map(p => safeKeys(p, partKeys)) }
    const previous = this.result.structures.find(s => JSON.stringify({ ...s, count: undefined }) === JSON.stringify(structure))
    if (previous) previous.count++
    else if (this.result.structures.length < 32) this.result.structures.push({ ...structure, count: 1 })
    else this.result.omitted_structures++
  }
  end(): void {
    this.consume(this.decoder.decode())
    if (this.line && !this.oversized) { this.consumeLine(this.line.replace(/\r$/, '')); this.line = '' }
    this.flush(); this.result.complete = true
  }
}

function safeGenerationConfig(body: Record<string, unknown>) {
  const request = isRecord(body.request) ? body.request : {}
  const config = isRecord(request.generationConfig) ? request.generationConfig : {}
  const thinking = isRecord(config.thinkingConfig) ? config.thinkingConfig : {}
  return {
    maxOutputTokens: typeof config.maxOutputTokens === 'number' && Number.isSafeInteger(config.maxOutputTokens) ? config.maxOutputTokens : null,
    thinkingConfig: Object.hasOwn(config, 'thinkingConfig') ? {
      thinkingLevel: typeof thinking.thinkingLevel === 'string' && ['low', 'medium', 'high', 'LOW', 'MEDIUM', 'HIGH'].includes(thinking.thinkingLevel) ? thinking.thinkingLevel : null,
      thinkingBudget: typeof thinking.thinkingBudget === 'number' && Number.isSafeInteger(thinking.thinkingBudget) ? thinking.thinkingBudget : null,
      includeThoughts: typeof thinking.includeThoughts === 'boolean' ? thinking.includeThoughts : null,
    } : null,
  }
}
interface HttpDiagnostic {
  operation: 'catalog' | 'inference' | 'other'
  status: number | null
  transport_error: boolean
  request?: { model: string | null; generationConfig: ReturnType<typeof safeGenerationConfig>; tools: number }
  sse?: SseDiagnostics
}
function observedFetch(http: FetchLike, rows: HttpDiagnostic[]): FetchLike {
  return async (url, init) => {
    const operation = String(url) === STREAM_URL ? 'inference' : String(url) === CONTROL_ENDPOINTS.fetchAvailableModels ? 'catalog' : 'other'
    const row: HttpDiagnostic = { operation, status: null, transport_error: false }
    rows.push(row)
    if (operation === 'inference') {
      try {
        const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '')
        if (isRecord(body)) {
          const req = isRecord(body.request) ? body.request : {}
          const tools = Array.isArray(req.tools) && isRecord(req.tools[0]) && Array.isArray(req.tools[0].functionDeclarations) ? req.tools[0].functionDeclarations.length : 0
          row.request = { model: typeof body.model === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(body.model) ? body.model : null, generationConfig: safeGenerationConfig(body), tools }
        }
      } catch { /* malformed request remains unreported, never copied into diagnostics */ }
    }
    let response: Response
    try { response = await http(url, init) } catch (error) { row.transport_error = true; throw error }
    row.status = response.status
    if (operation !== 'inference' || !response.ok || !response.body) return response
    const observer = new SafeSseObserver()
    row.sse = observer.result
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { observer.feed(chunk); controller.enqueue(chunk) },
      flush() { observer.end() },
    })), { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
export function safeAntigravityProbeFailure(error: unknown) {
  const status = error instanceof ModelHTTPError && Number.isInteger(error.status_code) ? error.status_code : null
  const category = error instanceof ModelHTTPError
    ? status === 401 || status === 403 ? 'access' : status === 429 ? 'rate_limit' : 'http'
    : error instanceof TransportError ? 'transport'
      : error instanceof NativeAuthTemporaryError ? 'auth_temporary'
        : error instanceof NativeAuthError ? 'auth'
          : error instanceof AntigravityCarrierError ? 'tool_encoding'
          : error instanceof ModelAPIError ? 'protocol'
            : error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'probe_contract'
  return { status, category }
}
function eventCounts() { return { total: 0, text_delta: 0, thinking_delta: 0, tool_delta: 0 } }
function countEvent(counts: ReturnType<typeof eventCounts>, event: StreamEvent) {
  counts.total++
  if (event.type === 'part_delta') {
    if (event.delta.part_kind === 'text') counts.text_delta++
    else if (event.delta.part_kind === 'thinking') counts.thinking_delta++
    else if (event.delta.part_kind === 'tool-call') counts.tool_delta++
  }
}
function safeResponse(response: ModelResponse) {
  return {
    finish_reason: ['stop', 'length', 'content_filter', 'tool_call', 'error'].includes(String(response.finish_reason)) ? response.finish_reason : null,
    usage: response.usage ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, cache_read_tokens: response.usage.cache_read_tokens, cache_write_tokens: response.usage.cache_write_tokens } : null,
    parts: { text: response.parts.filter(p => p.part_kind === 'text').length, thinking: response.parts.filter(p => p.part_kind === 'thinking').length, tool_calls: response.parts.filter(isToolCall).length, signatures: response.parts.filter(p => isRecord(p.provider_details) && typeof p.provider_details.thought_signature === 'string').length },
  }
}
interface ProbeRound { round: number; http: HttpDiagnostic[]; stream_events: ReturnType<typeof eventCounts>; response?: ReturnType<typeof safeResponse> }
interface RouteReport { route: string; ok: boolean; stage: Stage; tool_executed: boolean; nonce_verified: boolean; rounds: ProbeRound[]; failure?: ReturnType<typeof safeAntigravityProbeFailure> }
export interface ProbeOptions { live: boolean; authDir: string | null; routes: string[]; thinking: ProbeThinking; timeoutMs: number }
export function parseProbeOptions(argv: string[]): ProbeOptions {
  let live = false, dryRun = false, authDir: string | null = null, route: string | null = null, thinking: ProbeThinking = 'default', timeoutMs = 180_000
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--live') live = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--auth-dir' && argv[i + 1]) authDir = argv[++i]!
    else if (arg === '--route' && argv[i + 1]) route = argv[++i]!
    else if (arg === '--thinking' && argv[i + 1]) {
      const value = argv[++i]!
      if (!['default', 'low', 'medium', 'high'].includes(value)) throw new ProbeContractError()
      thinking = value as ProbeThinking
    } else if (arg === '--timeout-ms' && argv[i + 1]) {
      timeoutMs = Number(argv[++i])
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new ProbeContractError()
    } else throw new ProbeContractError()
  }
  if ((live && dryRun) || (live && (!authDir || !isAbsolute(authDir)))) throw new ProbeContractError()
  const routes = Object.keys(SUPPORTED_MODELS).map(id => 'antigravity:' + id)
  if (route !== null && !routes.includes(route)) throw new ProbeContractError()
  return { live, authDir, routes: route === null ? routes : [route], thinking, timeoutMs }
}
export interface ProbeDependencies {
  /** Injection exists for offline tests; the CLI always constructs the real manager for the explicit directory. */
  manager?: (authDir: string) => GrantSource
  fetchImpl?: FetchLike
}
export async function runAntigravityProbe(argv: string[], dependencies: ProbeDependencies = {}) {
  const options = parseProbeOptions(argv)
  const params: ModelRequestParameters = { function_tools: buildAgent().toolDefinitions(), allow_text_output: true, thinking: options.thinking === 'default' ? null : options.thinking }
  const report = { live: options.live, requested_thinking: options.thinking, tools: params.function_tools.length, tool_names: params.function_tools.map(t => t.name), tool_schema_sha256: createHash('sha256').update(JSON.stringify(params.function_tools)).digest('hex'), tool_schema_fingerprint: toolSchemaFingerprint(params), selected_routes: options.routes, results: [] as RouteReport[] }
  if (!options.live) return { exitCode: 0, report }
  // No default auth directory or credential import from another application is possible here.
  const manager = (dependencies.manager ?? tokenManager)(options.authDir!)
  const folder = mkdtempSync(join(tmpdir(), 'oasis-antigravity-probe-'))
  try {
    for (const route of options.routes) {
      const path = join(folder, randomUUID() + '.txt')
      const nonce = 'probe-' + randomUUID()
      writeFileSync(path, nonce, { mode: 0o600 })
      const result: RouteReport = { route, ok: false, stage: 'prepare', tool_executed: false, nonce_verified: false, rounds: [] }
      report.results.push(result)
      try {
        const signal = AbortSignal.timeout(options.timeoutMs)
        const settings = { cache_key: 'oasis-antigravity-probe-' + randomUUID() }
        const history: ModelMessage[] = [modelRequest([userPrompt('Briefly plan the requested file read, then call read_file exactly once. No other tool. Fixture path: ' + JSON.stringify(path) + '\nUse offset 1. After the result, reply with its exact content and no other text; the content is unknown until the tool returns it.')])]
        const request = async (round: number) => {
          const record: ProbeRound = { round, http: [], stream_events: eventCounts() }
          result.rounds.push(record)
          const model = new AntigravityModel(route.slice('antigravity:'.length), manager, { fetchImpl: observedFetch(dependencies.fetchImpl ?? ((url, init) => safeFetch(url, init)), record.http), maxRetries: 0 })
          const stream = await model.requestStream(history, settings, params, { signal })
          for await (const event of stream.events()) countEvent(record.stream_events, event)
          const response = stream.get()
          record.response = safeResponse(response)
          return response
        }
        result.stage = 'first_request'
        const first = await request(1)
        result.stage = 'tool_validation'
        const calls = first.parts.filter(isToolCall)
        if (calls.length !== 1 || calls[0]!.tool_name !== 'read_file') throw new ProbeContractError()
        const call = calls[0]!, args = argsDict(call.args)
        if (args.path !== path || Object.keys(args).some(k => !['path', 'offset', 'limit'].includes(k))
          || (args.offset !== undefined && args.offset !== 1)
          || (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 400))) throw new ProbeContractError()
        // This is the sole executable tool path. The fixture is a fresh private file, never a provider-selected path.
        const content = readFileSync(path, 'utf8')
        if (content !== nonce) throw new ProbeContractError()
        result.tool_executed = true
        history.push(first, modelRequest([toolReturn('read_file', { status: 'ok', path, content, from_line: 1, to_line: 1, total_lines: 1, truncated: false }, call.tool_call_id)]))
        result.stage = 'continuation_request'
        const second = await request(2)
        result.stage = 'continuation_validation'
        if (second.parts.some(isToolCall) || answerText(second.parts).trim() !== nonce) throw new ProbeContractError()
        result.nonce_verified = true; result.ok = true
      } catch (error) { result.failure = safeAntigravityProbeFailure(error) }
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
  return { exitCode: report.results.every(r => r.ok) ? 0 : 1, report }
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const result = await runAntigravityProbe(argv)
    console.log(JSON.stringify(result.report))
    return result.exitCode
  } catch (error) {
    console.log(JSON.stringify({ live_requested: argv.includes('--live'), ok: false, failure: safeAntigravityProbeFailure(error), usage: 'Use --dry-run, or --live --auth-dir ABSOLUTE_PATH; optionally --route antigravity:MODEL --thinking default|low|medium|high --timeout-ms 1000..600000' }))
    return 1
  }
}
if (import.meta.main) process.exitCode = await main()

