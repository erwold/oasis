/** The three providers' streaming protocols as recorded from real traffic, reduced to what the mappings read:
 *  Anthropic Messages events, OpenAI Responses events, Gemini streamGenerateContent chunks. The harness-level
 *  tests (the runner over a mock route) and the model-level ones share these. */

import { sse } from './helpers.ts'

export const READ_CALC = { path: 'calc.py' }

// -- Anthropic Messages streaming -----------------------------------------------------

export function anthropicStream(opts: {
  model: string; blocks: Record<string, unknown>[]; stop: string; input_tokens?: number; output_tokens?: number; cache_read?: number
}): string {
  const events: [string, unknown][] = [['message_start', { type: 'message_start', message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: opts.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: opts.input_tokens ?? 10, output_tokens: 1, cache_read_input_tokens: opts.cache_read ?? 0, cache_creation_input_tokens: 0 },
  } }]]
  opts.blocks.forEach((block, i) => {
    if (block.type === 'thinking') {
      events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: block.thinking } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: block.signature } }])
    } else if (block.type === 'text') {
      // a cited text block (web search): opens with an empty citation list, its citations come before its words
      const citations = block.citations as Record<string, unknown>[] | undefined
      events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: citations ? { citations: [], type: 'text', text: '' } : { type: 'text', text: '' } }])
      for (const citation of citations ?? []) events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'citations_delta', citation } }])
      for (const piece of block.pieces as string[]) {
        events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } }])
      }
    } else if (block.type === 'server_tool_use') {
      // Anthropic's own web search: the call with its input streamed, then its result block whole
      events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'server_tool_use', id: block.id, name: block.name, input: {} } }])
      const json = JSON.stringify(block.input)
      for (const piece of ['', json.slice(0, 8), json.slice(8)]) events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: piece } }])
    } else if (block.type === 'web_search_tool_result') {
      events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: block }])
    } else if (block.type === 'tool_use') {
      events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }])
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index: i }])
  })
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: opts.stop, stop_sequence: null }, usage: { output_tokens: opts.output_tokens ?? 7 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return sse(events)
}

// -- OpenAI Responses streaming -------------------------------------------------------

export function openaiStream(opts: { model: string; items: Record<string, unknown>[]; input_tokens?: number; output_tokens?: number; cached?: number }): string {
  let seq = 0
  const n = () => ++seq
  const base = { id: 'resp_1', object: 'response', created_at: 1, model: opts.model, output: [], parallel_tool_calls: true, tool_choice: 'auto', tools: [] }
  const events: [string, unknown][] = [['response.created', { type: 'response.created', sequence_number: n(), response: { ...base, status: 'in_progress' } }]]
  const doneItems: unknown[] = []
  opts.items.forEach((item, idx) => {
    let done: Record<string, unknown>
    if (item.type === 'message') {
      const added = { id: item.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
      events.push(['response.output_item.added', { type: 'response.output_item.added', sequence_number: n(), output_index: idx, item: added }])
      events.push(['response.content_part.added', { type: 'response.content_part.added', sequence_number: n(), output_index: idx, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }])
      for (const piece of item.pieces as string[]) {
        events.push(['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: n(), output_index: idx, item_id: item.id, content_index: 0, delta: piece, logprobs: [] }])
      }
      const text = (item.pieces as string[]).join('')
      events.push(['response.output_text.done', { type: 'response.output_text.done', sequence_number: n(), output_index: idx, item_id: item.id, content_index: 0, text, logprobs: [] }])
      events.push(['response.content_part.done', { type: 'response.content_part.done', sequence_number: n(), output_index: idx, item_id: item.id, content_index: 0, part: { type: 'output_text', text, annotations: [] } }])
      done = { id: item.id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    } else if (item.type === 'function_call') {
      const added = { id: item.id, type: 'function_call', call_id: item.call_id, name: item.name, arguments: '', status: 'in_progress' }
      events.push(['response.output_item.added', { type: 'response.output_item.added', sequence_number: n(), output_index: idx, item: added }])
      const args = JSON.stringify(item.arguments)
      events.push(['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', sequence_number: n(), output_index: idx, item_id: item.id, delta: args }])
      events.push(['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', sequence_number: n(), output_index: idx, item_id: item.id, arguments: args }])
      done = { ...added, arguments: args, status: 'completed' }
    } else if (item.type === 'reasoning') {
      const added = { id: item.id, type: 'reasoning', summary: [], encrypted_content: item.encrypted_content }
      events.push(['response.output_item.added', { type: 'response.output_item.added', sequence_number: n(), output_index: idx, item: added }])
      events.push(['response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', sequence_number: n(), output_index: idx, item_id: item.id, summary_index: 0, part: { type: 'summary_text', text: '' } }])
      events.push(['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', sequence_number: n(), output_index: idx, item_id: item.id, summary_index: 0, delta: item.summary }])
      events.push(['response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', sequence_number: n(), output_index: idx, item_id: item.id, summary_index: 0, text: item.summary }])
      events.push(['response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', sequence_number: n(), output_index: idx, item_id: item.id, summary_index: 0, part: { type: 'summary_text', text: item.summary } }])
      done = { id: item.id, type: 'reasoning', summary: [{ type: 'summary_text', text: item.summary }], encrypted_content: item.encrypted_content }
    } else {
      throw new Error(String(item.type))
    }
    events.push(['response.output_item.done', { type: 'response.output_item.done', sequence_number: n(), output_index: idx, item: done }])
    doneItems.push(done)
  })
  const input = opts.input_tokens ?? 11
  const output = opts.output_tokens ?? 6
  const usage = { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: opts.cached ?? 0 }, output_tokens_details: { reasoning_tokens: 0 } }
  events.push(['response.completed', { type: 'response.completed', sequence_number: n(), response: { ...base, status: 'completed', output: doneItems, usage } }])
  return sse(events)
}

// -- Gemini streamGenerateContent ------------------------------------------------------

export const GEMINI_SIGNATURE = Buffer.from('gemini-thought-signature-1').toString('base64')

export function geminiChunk(parts: Record<string, unknown>[], opts: { finish?: string; usage?: Record<string, number> } = {}): Record<string, unknown> {
  const candidate: Record<string, unknown> = { content: { role: 'model', parts }, index: 0 }
  if (opts.finish) candidate.finishReason = opts.finish
  const chunk: Record<string, unknown> = { candidates: [candidate], modelVersion: 'gemini-z', responseId: 'resp-g-1' }
  if (opts.usage) chunk.usageMetadata = opts.usage
  return chunk
}

export function geminiStream(chunks: Record<string, unknown>[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('')
}

export function geminiUsage(prompt: number, out: number, cached = 0): Record<string, number> {
  return { promptTokenCount: prompt, candidatesTokenCount: out, totalTokenCount: prompt + out, cachedContentTokenCount: cached }
}

// -- the recorded conversations -------------------------------------------------------

export function anthropicResponses(): string[] {
  return [
    anthropicStream({ model: 'claude-x', stop: 'tool_use', blocks: [
      { type: 'thinking', thinking: 'I should read the file first.', signature: 'sig-claude-1' },
      { type: 'text', pieces: ['Let me ', 'read calc.py.'] },
      { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: READ_CALC }] }),
    anthropicStream({ model: 'claude-x', stop: 'end_turn', cache_read: 4, blocks: [{ type: 'text', pieces: ['calc.py ', 'has a bug in add().'] }] }),
  ]
}

export function openaiResponses(): string[] {
  return [
    openaiStream({ model: 'gpt-y', items: [
      { type: 'reasoning', id: 'rs_1', summary: 'Reading first.', encrypted_content: 'ENCRYPTED-REASONING' },
      { type: 'message', id: 'msg_1', pieces: ['Reading ', 'calc.py.'] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_01', name: 'read_file', arguments: READ_CALC }] }),
    openaiStream({ model: 'gpt-y', items: [{ type: 'message', id: 'msg_2', pieces: ['add() subtracts.'] }], cached: 3 }),
  ]
}

export function geminiResponses(): string[] {
  return [
    geminiStream([
      geminiChunk([{ text: 'Weighing where to look.', thought: true }]),
      geminiChunk([{ text: 'Reading calc.py.' }]),
      geminiChunk([{ functionCall: { name: 'read_file', args: READ_CALC }, thoughtSignature: GEMINI_SIGNATURE }], { finish: 'STOP', usage: geminiUsage(12, 5) }),
    ]),
    geminiStream([geminiChunk([{ text: 'add() subtracts; ' }]), geminiChunk([{ text: 'that is the bug.' }], { finish: 'STOP', usage: geminiUsage(40, 6, 8) })]),
  ]
}

// -- the Codex route's stream (test_auth_native) ---------------------------------------

export function codexSse(output: Record<string, unknown>[]): string {
  const response: Record<string, unknown> = { id: 'resp_test', object: 'response', created_at: 1900000000, model: 'gpt-6-astra', status: 'in_progress', output: [] }
  const events: Record<string, unknown>[] = [{ type: 'response.created', response: { ...response }, sequence_number: 0 }]
  output.forEach((item, i) => {
    events.push({ type: 'response.output_item.added', output_index: i, item, sequence_number: events.length })
    if (item.type === 'message') {
      events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: i, content_index: 0, delta: (item.content as { text: string }[])[0]!.text, sequence_number: events.length })
    } else if (item.type === 'function_call') {
      events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: i, delta: item.arguments, sequence_number: events.length })
    }
    events.push({ type: 'response.output_item.done', output_index: i, item, sequence_number: events.length })
  })
  Object.assign(response, { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } })
  events.push({ type: 'response.completed', response, sequence_number: events.length })
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

export function textOutput(text = 'OK'): Record<string, unknown>[] {
  return [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }]
}

export function anthropicSse(): string {
  const events = [
    { type: 'message_start', message: { id: 'msg_stream', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}
