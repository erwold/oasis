/** The agent: instructions, the registry's tools, a history processor (harness notes, the context keeper's
 *  compaction, the crash stash) and a per-request tool selection (the run's visible surface). */

import { APP_ORIGIN, isRequest, userPrompt, type ModelMessage, type ModelRequest } from '../llm/messages.ts'
import type { BuiltinTool, Model, ToolDefinition } from '../llm/model.ts'
import { searchEngineForRun } from '../search/settings.ts'
import { networkGranted } from '../policy/permissions.ts'
import { refreshSession, type AgentDeps } from './deps.ts'
import { INSTRUCTIONS } from './instructions.ts'
import { Agent, type RequestSeam } from './loop.ts'
import { freezeProviderFrame } from './provider_surface.ts'
import './tools/index.ts'
import { loopTools, visibleToolNames } from './tools/registry.ts'
import { text } from '../prompt_texts.ts'
import { newId } from '../ids.ts'

/** The notes appended to the pending request (the one about to go out, never one a provider has seen), then the
 *  keeper's word on the record: unchanged while the next request fits under the threshold, else one compaction
 *  request appended (or a failed attempt reported, the request then made as it is). */
async function processHistory(deps: AgentDeps, messagesIn: ModelMessage[], seam: RequestSeam): Promise<ModelMessage[]> {
  let messages = messagesIn
  const notes = deps.pending_notes
  const last = messages[messages.length - 1]
  if (notes.length && last && isRequest(last)) {
    // a note that is a whole app note already (it begins with the header) goes as its own part; the rest under one
    const own = notes.filter((n) => n.startsWith('App note'))
    const plain = notes.filter((n) => !n.startsWith('App note'))
    const parts = [...last.parts, ...(plain.length ? [userPrompt(text('app.note_header', { notes: plain.join('\n') }), APP_ORIGIN)] : []), ...own.map((n) => userPrompt(n, APP_ORIGIN))]
    const noted: ModelRequest = { ...last, parts }
    messages = [...messages.slice(0, -1), noted]
    notes.length = 0
    deps.instructions_pending.clear()
  }
  // the closing turn is one request, the report: no summary is asked in it
  if (deps.context !== null && deps.closing() === null) {
    // the person's words waiting for this request count toward its size: a compaction makes room for them whole
    let compactionId: string | null = null
    try {
      const [kept, report] = await deps.context.maybeCompact(messages, seam, deps.steering?.peek() ?? [], () => {
        compactionId = newId('compact')
        deps.emit('context_compacting', { compaction_id: compactionId, covers: messages.length })
      })
      messages = kept
      if (report !== null) deps.emit('context_compacted', { ...report, ...(compactionId ? { compaction_id: compactionId } : {}) })
    } catch (error) {
      // A stopped summary or an unrecoverable overflow still closes its progress row; the loop handles the error.
      if (compactionId) deps.emit('context_compacted', { compaction_id: compactionId, covers: messages.length, status: seam.ctx?.signal?.aborted ? 'cancelled' : 'failed' })
      throw error
    }
  }
  // Closing turns skip summaries, not the hard window check. Refuse before stashing: an unsent oversized input
  // stays in run.user_text/attachments, not in the model history that the next run inherits.
  deps.context?.assertFits(messages, seam)
  deps.on_history(messages)
  return messages
}

/** Which registered tools THIS run's model sees, decided per request: the run surface, cut to the order's `tools`
 *  under an order; a tool left out is neither described nor callable. A closing turn (a hard budget reached) keeps
 *  the same descriptions — the tools are the first thing a provider's prompt cache keys on — while the registry
 *  refuses to run any of them. Not a permission — a visible tool still crosses the order's refusals and the session
 *  gate at call time. */
function prepareTools(deps: AgentDeps, defs: ToolDefinition[]): ToolDefinition[] {
  if (deps.closing()) deps.closing_requests += 1
  // a conversation's own tool list (schema v25): its names, descriptions and schemas as its first run had them,
  // byte for byte, whatever the registry or an order says since (a call the run may not make now is refused at it)
  const snapshot = deps.tool_snapshot
  if (snapshot !== null) {
    // in the snapshot's own order (the order its first request listed them in); a tool this build no longer has is
    // still described as the conversation knows it — a call of it is answered as an unknown tool, never run
    return snapshot.rows.map((row) => ({ name: row.name, description: row.description, parameters_json_schema: row.parameters as ToolDefinition['parameters_json_schema'] }))
  }
  const visible = visibleToolNames({ order: deps.work_order })
  return defs.filter((t) => visible.has(t.name))
}

/** How many searches the provider's own web search may make in one response. */
export const BUILTIN_SEARCHES_PER_RESPONSE = 5

/** The provider's own web search in place of the harness's `web_search`, where the route has one: while the run may
 *  use the web search at all (the tool is on its surface and its order allows the network) and the session's grant
 *  lets the network through as it stands. A search the provider runs is not the harness's to hold for approval, so a
 *  network that asks the person first keeps the harness's tool (whose calls ask). */
function builtinTools(deps: AgentDeps, model: Model, defs: ToolDefinition[]): BuiltinTool[] {
  if (searchEngineForRun(deps) !== 'automatic') return []
  if (!model.profile.builtin_tools?.includes('web_search') || !defs.some((d) => d.name === 'web_search')) return []
  if (deps.work_order !== null && !deps.work_order.execution.network) return []
  if (!networkGranted(refreshSession(deps).grants)) return []
  return [{ kind: 'web_search', max_uses: BUILTIN_SEARCHES_PER_RESPONSE }]
}

export function buildAgent(): Agent<AgentDeps> {
  return new Agent<AgentDeps>({
    instructions: INSTRUCTIONS, tools: loopTools(), processHistory, prepareTools, builtinTools, retries: 3,
    // the conversation's provider frame (tools as sent, provider tools, instructions) replayed, or the request refused
    prepareRequest: freezeProviderFrame,
    // the person's words sent while the run works, handed at request boundaries (agent/steering.ts)
    input: {
      pending: (deps) => deps.steering?.pending() ?? false,
      deliver: (deps, messages, seam, must) => (deps.steering ? deps.steering.deliver(messages, seam, must) : messages),
      close: (deps) => deps.steering?.close(),
    },
    // every accepted response and every tool return reaches the stash as it happens
    onMessages: (deps, messages) => deps.on_history(messages),
  })
}
