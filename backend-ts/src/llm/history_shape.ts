/** Structural history rules shared by continuation and its derived read projection. No DB, runner or model I/O. */
import { isRequest, isResponse, isRetryPrompt, isToolCall, isToolReturn, type ModelMessage, type ToolCallPart } from './messages.ts'

export function lastCompactionIndex(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (isRequest(m) && m.compaction !== undefined && m.compaction !== null) return i
  }
  return -1
}

/** The input is the working view, not the summarized prefix. Keep order and duplicate call ids as the runner did. */
export function danglingToolCalls(view: ModelMessage[]): ToolCallPart[] {
  const answered = new Set<string>()
  for (const message of view) {
    if (isRequest(message)) for (const part of message.parts) if ((isToolReturn(part) || isRetryPrompt(part)) && part.tool_call_id) answered.add(part.tool_call_id)
  }
  const dangling: ToolCallPart[] = []
  for (const message of view) {
    if (isResponse(message)) for (const part of message.parts) if (isToolCall(part) && !answered.has(part.tool_call_id)) dangling.push(part)
  }
  return dangling
}
