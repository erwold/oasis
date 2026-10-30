/** Cross-provider continuation. The history belongs to the harness. When a session continues on another provider,
 *  what is portable — the user's goals, visible text, tool calls, tool results, file references — is kept verbatim;
 *  what is not — provider reasoning blocks and their signatures, provider response ids, native item ids — is
 *  removed HERE, counted, and replaced by one explicit handoff note the model reads. Nothing is dropped silently. */

import {
  answerText, APP_ORIGIN, isRequest, isResponse, isText, isThinking, isToolCall, modelRequest, textPart, userPrompt, type ModelMessage, type ModelResponse, type ResponsePart,
} from './messages.ts'
import { PROMPT_TEXT, text } from '../prompt_texts.ts'

export interface HandoffReport {
  foreign_responses: number
  dropped_thinking_parts: number
  stripped_item_ids: number
  foreign_models: string[]
  target: string
}

/** The route a response was stamped with by the model that made it, or null for one made before routes were
 *  stamped (or by a model that stamps none). */
export function responseRoute(message: ModelResponse): string | null {
  const route = message.provider_details?.route
  return typeof route === 'string' ? route : null
}

/** Whether a response is the target's own: its provider, and — where both are known — its route (endpoint and
 *  model). Another route of one vendor is another account, endpoint or model: its encrypted reasoning, signatures
 *  and item ids are no good there. */
function ownResponse(message: ModelResponse, targetSystem: string, targetRoute: string | null): boolean {
  if (message.provider_name !== targetSystem) return false
  const route = responseRoute(message)
  return targetRoute === null || route === null || route === targetRoute
}

/** Returns (messages the target may receive, a report). Responses from the target's own route pass untouched
 *  (their signatures stay valid); foreign ones keep text and tool calls, lose reasoning and provider references. */
export function portableHistory(messages: ModelMessage[], targetSystem: string, targetRoute: string | null = null): [ModelMessage[], HandoffReport] {
  const out: ModelMessage[] = []
  let droppedThinking = 0
  let foreignResponses = 0
  const foreignModels: string[] = []
  let strippedIds = 0
  for (const message of messages) {
    if (!isResponse(message) || message.provider_name == null || ownResponse(message, targetSystem, targetRoute)) {
      out.push(message)
      continue
    }
    foreignResponses += 1
    if (message.model_name && !foreignModels.includes(message.model_name)) foreignModels.push(message.model_name)
    const parts: ResponsePart[] = []
    for (const part of message.parts) {
      if (isThinking(part)) { droppedThinking += 1; continue }
      if (isText(part)) {
        // the pages the words cite go with them as links (the citation itself is its provider's form)
        parts.push({ ...part, content: answerText([part]), id: null, provider_name: null, provider_details: null })
      } else if (isToolCall(part)) {
        if (part.id) strippedIds += 1
        parts.push({ ...part, id: null, provider_name: null, provider_details: null })
      } else {
        // native tool parts (web search etc.) have no portable form: replaced by a text marker
        parts.push(textPart(text('app.unavailable_part', { kind: part.part_kind })))
      }
    }
    if (parts.length === 0) parts.push(textPart(PROMPT_TEXT['app.unavailable_reasoning']))
    out.push({ ...message, parts, provider_name: null, provider_response_id: null, provider_details: null, provider_url: null })
  }
  const report: HandoffReport = {
    foreign_responses: foreignResponses, dropped_thinking_parts: droppedThinking, stripped_item_ids: strippedIds,
    foreign_models: foreignModels, target: targetSystem,
  }
  return [out, report]
}

export function handoffNote(report: HandoffReport, fromModel: string | null, _toModel: string): string | null {
  if (!report.foreign_responses) return null
  return text('app.handoff', { models: fromModel || report.foreign_models.join(', ') || 'another provider' })
}

/** Append the note to the last request's parts (the request the model reads next), so the earlier prefix stays
 *  byte-identical. */
export function noteOnFirstRequest(messages: ModelMessage[], note: string): ModelMessage[] {
  const last = messages[messages.length - 1]
  if (last && isRequest(last)) return [...messages.slice(0, -1), { ...last, parts: [...last.parts, userPrompt(note, APP_ORIGIN)] }]
  return [...messages, modelRequest([userPrompt(note, APP_ORIGIN)])]
}
