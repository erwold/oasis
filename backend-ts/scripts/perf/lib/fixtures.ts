/** Seeded synthetic conversations for the perf harness: prose, markdown, code, logs, CJK-range characters and long
 *  unbroken tokens (hashes, base64), all generated from a fixed seed — no real record content anywhere. */

import type { ModelMessage, ModelRequest, ModelResponse, RequestPart, ResponsePart } from '../../../src/llm/messages.ts'
import type { ToolDefinition } from '../../../src/llm/model.ts'

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ('the a an of to in for on with by from at as is are was be this that these those it its run test file module '
  + 'function value result error build check change update read write path line return call config cache token stream event '
  + 'request response model context window summary history record branch commit merge diff patch worker queue timer watch '
  + 'latency memory heap process command output input schema database index query plan cursor batch segment limit').split(' ')
const IDENTS = ['handle', 'state', 'conn', 'repo', 'events', 'queue', 'cursor', 'session', 'workspace', 'runId', 'payload', 'options', 'buffer', 'count', 'total']
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export class TextGen {
  readonly r: () => number
  constructor(seed: number) { this.r = rng(seed) }
  int(lo: number, hi: number): number { return lo + Math.floor(this.r() * (hi - lo + 1)) }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.r() * xs.length)]! }
  word(): string { return this.pick(WORDS) }
  sentence(): string { const n = this.int(6, 18); const w = Array.from({ length: n }, () => this.word()); w[0] = w[0]!.charAt(0).toUpperCase() + w[0]!.slice(1); return `${w.join(' ')}.` }
  prose(chars: number): string { let s = ''; while (s.length < chars) s += (s ? ' ' : '') + this.sentence(); return s.slice(0, chars) }
  markdown(chars: number): string {
    let s = ''
    while (s.length < chars) {
      const k = this.int(0, 3)
      s += k === 0 ? `## ${this.prose(30)}\n\n` : k === 1 ? `- ${this.prose(this.int(40, 120))}\n` : k === 2 ? `\`\`\`ts\n${this.code(this.int(120, 400))}\n\`\`\`\n` : `${this.prose(this.int(100, 400))}\n\n`
    }
    return s.slice(0, chars)
  }
  code(chars: number): string {
    let s = ''
    while (s.length < chars) {
      const a = this.pick(IDENTS), b = this.pick(IDENTS), ind = '  '.repeat(this.int(0, 3))
      const k = this.int(0, 4)
      s += k === 0 ? `${ind}const ${a}${this.int(0, 99)} = ${b}.${this.word()}(${this.int(0, 999)})\n`
        : k === 1 ? `${ind}if (${a} !== null && ${b}.length > ${this.int(1, 64)}) return ${a}\n`
          : k === 2 ? `${ind}// ${this.prose(this.int(20, 70))}\n`
            : k === 3 ? `${ind}export function ${a}${this.word()}(${b}: string): number {\n`
              : `${ind}}\n`
    }
    return s.slice(0, chars)
  }
  log(chars: number): string {
    let s = '', i = 0
    while (s.length < chars) s += `[${String(i++).padStart(5, '0')}] ${this.pick(['INFO', 'WARN', 'DEBUG'])} ${this.word()}=${this.int(0, 99999)} ${this.prose(this.int(20, 80))}\n`
    return s.slice(0, chars)
  }
  /** characters drawn from the CJK unified range (meaningless, synthetic) mixed with ASCII punctuation */
  cjk(chars: number): string {
    let s = ''
    while (s.length < chars) s += this.r() < 0.1 ? '，' : String.fromCharCode(0x4e00 + this.int(0, 2000))
    return s
  }
  longToken(chars: number): string { let s = ''; for (let i = 0; i < chars; i++) s += B64[this.int(0, 63)]; return s }
  hex(chars: number): string { let s = ''; for (let i = 0; i < chars; i++) s += '0123456789abcdef'[this.int(0, 15)]; return s }
}

export const FIXED_TS = '2026-10-18T00:00:00.000Z'

export interface HistoryOptions {
  turns: number
  tool_calls_per_turn: number
  seed: number
  /** every Nth turn begins with a new user message (else the turn is the tool loop continuing) */
  user_every?: number
  /** median text chars of a tool return */
  return_chars?: number
}

export interface HistoryShape { messages: number; parts: number; tool_calls: number; json_bytes: number }

/** A record the runner could have written: request (user prompt) → response (thinking?, text, tool calls) → request
 *  (tool returns) …, ending with a request (the state in which a compaction is considered). */
export function buildHistory(o: HistoryOptions): ModelMessage[] {
  const g = new TextGen(o.seed)
  const userEvery = o.user_every ?? 10
  const retChars = o.return_chars ?? 2400
  const out: ModelMessage[] = []
  let pendingReturns: RequestPart[] = []
  let call = 0
  for (let t = 0; t < o.turns; t++) {
    const parts: RequestPart[] = [...pendingReturns]
    pendingReturns = []
    if (t % userEvery === 0) {
      const text = g.r() < 0.15 ? `${g.prose(g.int(80, 400))}\n${g.cjk(g.int(20, 120))}` : g.prose(g.int(80, 600))
      parts.push({ part_kind: 'user-prompt', content: text, timestamp: FIXED_TS, origin: 'person' } as RequestPart)
    }
    if (!parts.length) parts.push({ part_kind: 'user-prompt', content: g.prose(60), timestamp: FIXED_TS, origin: 'person' } as RequestPart)
    out.push({ kind: 'request', parts } as ModelRequest)
    const rparts: ResponsePart[] = []
    if (g.r() < 0.5) rparts.push({ part_kind: 'thinking', content: g.prose(g.int(100, 900)), signature: g.longToken(200) } as ResponsePart)
    rparts.push({ part_kind: 'text', content: g.markdown(g.int(150, 1500)) } as ResponsePart)
    for (let k = 0; k < o.tool_calls_per_turn; k++) {
      const id = `toolu_${String(++call).padStart(6, '0')}`
      const kind = g.int(0, 3)
      const name = kind === 0 ? 'read_file' : kind === 1 ? 'bash' : kind === 2 ? 'edit_file' : 'grep'
      const args = kind === 0 ? { path: `src/${g.word()}/${g.word()}_${g.int(0, 99)}.ts` }
        : kind === 1 ? { command: `bun test tests/${g.word()}_${g.int(0, 99)}.test.ts 2>&1 | tail -${g.int(10, 80)}`, wait_s: 120 }
          : kind === 2 ? { path: `src/${g.word()}.ts`, old_string: g.code(g.int(60, 300)), new_string: g.code(g.int(60, 300)) }
            : { pattern: `${g.pick(IDENTS)}\\(`, path: 'src' }
      rparts.push({ part_kind: 'tool-call', tool_name: name, args: JSON.stringify(args), tool_call_id: id } as ResponsePart)
      const size = Math.max(80, Math.round(retChars * (0.25 + g.r() * 1.5)))
      const content = kind === 0 ? g.code(size) : kind === 1 ? { execution_id: `x_${g.hex(12)}`, status: 'succeeded', exit_code: 0, stdout: g.log(size), stderr: '' }
        : kind === 2 ? { path: args.path, replaced: 1, diff: g.code(Math.min(size, 800)) } : g.log(Math.min(size, 1200))
      pendingReturns.push({ part_kind: 'tool-return', tool_name: name, content, tool_call_id: id, timestamp: FIXED_TS } as RequestPart)
    }
    out.push({
      kind: 'response', parts: rparts, usage: { input_tokens: 1000 + t * 900, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 200 },
      model_name: 'stub-model', timestamp: FIXED_TS, provider_name: 'anthropic', provider_details: null, provider_response_id: `msg_${t}`, finish_reason: o.tool_calls_per_turn ? 'tool_call' : 'stop',
    } as ModelResponse)
  }
  out.push({ kind: 'request', parts: pendingReturns.length ? pendingReturns : [{ part_kind: 'user-prompt', content: g.prose(200), timestamp: FIXED_TS, origin: 'person' } as RequestPart] } as ModelRequest)
  return out
}

export function shapeOf(messages: ModelMessage[]): HistoryShape {
  let parts = 0, calls = 0
  for (const m of messages) { parts += m.parts.length; for (const p of m.parts) if (p.part_kind === 'tool-call') calls++ }
  return { messages: messages.length, parts, tool_calls: calls, json_bytes: Buffer.byteLength(JSON.stringify(messages)) }
}

/** Synthetic tool definitions (used only when the real registry is not loaded). */
export function syntheticTools(n: number, seed: number): ToolDefinition[] {
  const g = new TextGen(seed)
  return Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`, description: g.prose(g.int(200, 1200)),
    parameters_json_schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: g.int(2, 8) }, (_, k) => [`p${k}`, { type: 'string', description: g.prose(g.int(30, 200)) }])), required: ['p0'] },
  }))
}
