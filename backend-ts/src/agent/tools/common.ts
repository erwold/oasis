/** Shared tool plumbing: every tool answers with a JSON-able payload and emits one tool_result event keyed by its
 *  tool_call_id (the UI's row identity), whichever of call and result reaches the client first. */

import { setGateHooks } from '../../policy/gate.ts'
import type { AgentDeps } from '../deps.ts'
import type { ToolContext } from '../loop.ts'
import { folderInstructions, folderOf, INSTRUCTION_FILES, instructionFingerprint } from '../project_instructions.ts'
import { PROMPT_TEXT, text } from '../../prompt_texts.ts'
import type { PurePath } from '../../workspace/paths.ts'
import { orderRefusal } from '../work_orders.ts'
import { specOf } from './registry.ts'

export { isBinary, sha256Of } from '../../workspace/reading.ts'

/** A read facade may label its delegate's single result without mutating shared run state. */
export type Ctx = ToolContext<AgentDeps> & { result_tool?: string; result_summary?: string }
export type Payload = Record<string, unknown>

export function finish(ctx: Ctx, tool: string, payload: Payload, summary: Record<string, unknown> = {}): Payload {
  ctx.deps.tool_calls += 1
  const resultTool = ctx.result_tool ?? tool
  const data = { ...summary, tool: resultTool, tool_call_id: ctx.tool_call_id, status: payload.status ?? 'ok',
    ...(resultTool !== tool ? { operation: tool, summary: summary.summary ?? ctx.result_summary ?? tool } : {}) }
  ctx.deps.emit('tool_result', data)
  return payload
}

export function refused(ctx: Ctx, tool: string, reason: string, extra: Record<string, unknown> = {}): Payload {
  const payload = { status: 'refused', reason, ...extra }
  return finish(ctx, tool, payload, { summary: reason.slice(0, 200) })
}

/** The work order's refusal of this call (checked before the session gate, so nothing reaches the workspace, the
 *  sandbox or the gate), as the payload the model gets back — counted on the run, shown in the thread as this
 *  call's tool_result; null to proceed. */
export function orderRefused(ctx: Ctx, tool: string, opts: { path?: string | null; network?: boolean } = {}): Payload | null {
  const deps = ctx.deps
  const order = deps.work_order
  if (order === null) return null
  const spec = specOf(tool)
  // the temporary folder is not the working folder: an order's read-only and scopes do not bound it
  let temp = false
  if (opts.path) { try { temp = deps.policy.isTemp(deps.policy.normalize(opts.path)) } catch { temp = false } }
  const reason = orderRefusal(order, tool, spec ? spec.effect : 'read', temp ? { ...opts, path: null, temp: true } : opts)
  if (reason === null) return null
  deps.blocked_calls += 1
  const payload = { status: 'refused_by_work_order', tool, reason: text('refusal.constraint', { reason }) }
  return finish(ctx, tool, payload, { summary: reason.slice(0, 200) })
}

/** The mark in a run's instruction scopes that the rule of folder scope has been shown. */
export const FOLDER_RULE_SHOWN = '#folder-rule'

/** A folder the run enters (a path it reads, writes or runs in): the instruction files of that folder and of the
 *  folders between it and the root, not shown yet — or rewritten since they were — are appended to the next
 *  request, once each, with the rule of scope the first time a folder's instructions appear. Returns the scope of
 *  the folder's rules that are on their way to the model and not in front of it yet (a change there waits), or null. */
export function noteFolderInstructions(ctx: Ctx, pure: PurePath, real: string): string | null {
  const deps = ctx.deps
  const folder = folderOf(pure, real)
  if (!folder.length) return null
  const files = folderInstructions(deps.policy, folder)
  for (const f of files) {
    const version = instructionFingerprint(f.text)
    const shown = deps.instruction_scopes.has(f.source)
    if (shown && deps.instruction_versions.get(f.source) === version) continue
    deps.instruction_scopes.add(f.source)
    deps.instruction_versions.set(f.source, version)
    deps.instructions_pending.add(f.source)
    deps.pending_notes.push(shown ? text('context.instructions_changed', { instructions: text('context.project', { source: f.source, scope: f.scope, text: f.text }) })
      : text('context.project', { source: f.source, scope: f.scope, text: f.text }))
  }
  if (files.length && !deps.instruction_scopes.has(FOLDER_RULE_SHOWN)) {
    deps.instruction_scopes.add(FOLDER_RULE_SHOWN)
    deps.pending_notes.push(PROMPT_TEXT['context.project_scope_rule'])
  }
  const pending = files.filter((f) => deps.instructions_pending.has(f.source))
  return pending.length ? pending[pending.length - 1]!.scope : null
}

/** Before a command: the instruction files of the folders the first message only named (over its discovery
 *  limit) are noted now, a batch at a time — a command can change files in any folder, whatever its cwd says —
 *  and the scopes whose rules are on their way to the model are returned (the command waits for them); empty when
 *  every folder's rules have been shown. */
export function noteUndeliveredInstructions(ctx: Ctx, batch: number): string[] {
  const deps = ctx.deps
  const scopes: string[] = []
  for (const folder of deps.instructions_undelivered.splice(0, batch)) {
    try {
      const [pure, real] = deps.policy.resolveRead(folder)
      const scope = noteFolderInstructions(ctx, pure, real)
      if (scope !== null) scopes.push(scope)
    } catch { /* gone or refused since: nothing to show */ }
  }
  return scopes
}

/** The folders whose instruction files are noted for the next request and not in front of the model yet. */
export function pendingScopes(deps: AgentDeps): string[] {
  const scopes = new Set<string>()
  for (const source of deps.instructions_pending) {
    const name = INSTRUCTION_FILES.find((f) => source === f || source.endsWith(`/${f}`))
    const folder = name === undefined ? source : source.slice(0, source.length - name.length)
    scopes.add(folder || 'the working folder')
  }
  return [...scopes]
}

/** A change in a folder whose instructions are on their way to the model but not in front of it yet is held: the
 *  payload that says so (nothing changed), or null to proceed. */
export function heldForInstructions(ctx: Ctx, tool: string, scope: string | null): Payload | null {
  if (scope === null) return null
  const payload = { status: 'deferred', tool, reason: text('refusal.folder_instructions', { scope }) }
  return finish(ctx, tool, payload, { summary: `held: the instructions for ${scope} are in this message` })
}

setGateHooks({ finish: (ctx, tool, result, summary) => finish(ctx as unknown as Ctx, tool, result, { summary }) })
