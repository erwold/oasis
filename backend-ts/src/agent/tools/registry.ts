/** The tool registry: one place that knows a tool's name, effect tag, the action its policy check needs, the UI
 *  renderer hint and its argument schema. The agent's toolset, the manifest, the gate and the UI all read it; adding
 *  a tool means adding one ToolSpec here and its function in its module — no other core module grows a branch for
 *  it. */

import { z } from '@oasis-code/contract'
import { allowsAgentEffect, inferMode } from '@oasis-code/contract/modes'
import { effectiveControl, setGateHooks } from '../../policy/gate.ts'
import { refreshSession, type AgentDeps } from '../deps.ts'
import type { Tool, ToolContext } from '../loop.ts'
import { cleanSchema } from '../../llm/http.ts'
import { PROMPT_TEXT } from '../../prompt_texts.ts'
// common.ts imports this module too; finish is only called at a tool call, long after both have loaded
import { finish } from './common.ts'

export type EffectTag = 'read' | 'compute' | 'workspace_write' | 'isolated_code_execution' | 'state_change' | 'network'
export type Renderer = 'generic' | 'file_read' | 'patch' | 'command' | 'process_output' | 'web' | 'computer'

export interface ToolSpec<A = unknown> {
  name: string
  effect: EffectTag
  action: string | null            // the grant the gate checks before the call; null = never gated
  renderer: Renderer
  summary: string
  /** what the model reads about the tool */
  description: string
  schema: z.ZodType<A>
  /** a check of the raw arguments before the schema reads them (a schema drops what it cannot hold — a
   *  `__proto__` key — where the tool must refuse it); an error message, or null */
  precheck?: (args: unknown) => string | null
  fn: (ctx: ToolContext<AgentDeps>, args: A) => Promise<Record<string, unknown>>
  /** 'thread': a run under an order does not see it (the watches: an order's run has its own conversation and a
   *  director); a relay's turn and an interaction's node see it — they carry the thread's conversation on, and the
   *  tools are the first thing a provider's prompt cache keys on — and the tool refuses them itself */
  scope?: 'thread'
}

const REGISTRY = new Map<string, ToolSpec>()

export function register<A>(spec: ToolSpec<A>): ToolSpec<A> {
  if (REGISTRY.has(spec.name)) throw new Error(`tool ${spec.name} registered twice`)
  REGISTRY.set(spec.name, spec as ToolSpec)
  return spec
}

/** The tool modules register on import; the registry pulls them in once, on first use. */
let loaded = false
/** The tool modules register themselves on import; a reader of the registry that never imported them (the gate,
 *  the manifest, a test) gets them loaded here, once. */
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  require('./index.ts')
}

/** Tests that replay what an older build sent: the named tools left out until `restore` puts the registry back as it
 *  was, in its order (the order a request lists the tools in). */
export function withoutToolsForTest(names: readonly string[]): { restore: () => void } {
  ensureLoaded()
  const kept = [...REGISTRY.entries()]
  for (const name of names) REGISTRY.delete(name)
  return { restore: () => { REGISTRY.clear(); for (const [name, spec] of kept) REGISTRY.set(name, spec) } }
}

export function specs(): ToolSpec[] {
  ensureLoaded()
  return [...REGISTRY.values()]
}

/** Every tool a run may be given (a work order's `tools` names a subset). */
export function runToolNames(): string[] {
  return specs().map((s) => s.name)
}

/** The run's tools: all of them, or exactly the ones its work order names; a UI task's result under no order. Visibility
 *  never expands permissions. */
export function visibleToolNames(opts: { order: { tools: string[] | null } | null }): Set<string> {
  const allowlist = opts.order?.tools ?? null
  return new Set(specs().filter((s) => (s.scope !== 'thread' || opts.order === null) && (allowlist === null || allowlist.includes(s.name))).map((s) => s.name))
}

export function specOf(name: string): ToolSpec | null {
  ensureLoaded()
  return REGISTRY.get(name) ?? null
}

export interface SurfaceRow { name: string; effect: EffectTag; action: string | null; renderer: Renderer; summary: string }

/** The catalog of the tools, as the UI and the manifest read it. */
export function surface(): SurfaceRow[] {
  return specs().map((s) => ({ name: s.name, effect: s.effect, action: s.action, renderer: s.renderer, summary: s.summary }))
}

/** The JSON schema of a tool's arguments as the model sees it (the manifest and the request records fingerprint the same rows). */
export function parametersSchema(spec: ToolSpec): Record<string, unknown> {
  return cleanSchema(z.toJSONSchema(spec.schema, { io: 'input' }) as Record<string, unknown>)
}

const schemaCache = new Map<string, Record<string, unknown>>()

/** The registry's tools as the agent loop calls them. */
export function loopTools(): Tool<AgentDeps>[] {
  return specs().map((spec) => {
    let parameters = schemaCache.get(spec.name)
    if (!parameters) {
      parameters = parametersSchema(spec)
      schemaCache.set(spec.name, parameters)
    }
    return {
      name: spec.name, description: spec.description, parameters_json_schema: parameters,
      validate: (args) => {
        const refused = spec.precheck?.(args) ?? null
        if (refused !== null) return { error: refused }
        const r = spec.schema.safeParse(args)
        return r.success ? { value: r.data } : { error: r.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ') }
      },
      // synchronous on purpose: the check reads the database and must not add an await before the tool itself runs (a
      // run's tools interleave with its siblings' — a message answered before the asker waits is another path)
      fn: (ctx, args) => {
        // the closing turn: the tool is described (the prompt cache keys on the descriptions) but nothing runs in it
        if (ctx.deps.closing() !== null) {
          ctx.deps.blocked_calls += 1
          const payload = { status: 'refused', reason: 'closing', message: PROMPT_TEXT['app.closing_tool'] }
          return Promise.resolve(finish(ctx, spec.name, payload, { summary: 'refused: the run is closing' }))
        }
        // a tool the conversation's list holds but this run may not call now (its order narrowed since; a run under an
        // order continuing a list made without one): refused here — the list itself never changes in a conversation
        if (ctx.deps.tool_allowed !== null && !ctx.deps.tool_allowed.has(spec.name)) {
          ctx.deps.blocked_calls += 1
          const payload = { status: 'refused', reason: 'not_allowed_now', message: `${spec.name} is not available to this run: its work order or its role leaves it out. The tool stays listed because this conversation's tool list does not change.` }
          return Promise.resolve(finish(ctx, spec.name, payload, { summary: 'refused: not available to this run' }))
        }
        // the session as it stands: a stale run snapshot or a run-specific gate must not bypass session Plan mode
        const session = refreshSession(ctx.deps)
        const mode = inferMode(session.grants, effectiveControl(ctx.deps.conn, session.id))
        if (!allowsAgentEffect(mode, spec.effect)) {
          ctx.deps.blocked_calls += 1
          const payload = { status: 'blocked', reason: 'plan_mode', message: PROMPT_TEXT['refusal.plan'] }
          return Promise.resolve(finish(ctx, spec.name, payload, { summary: 'blocked: the session is in Plan mode' }))
        }
        return spec.fn(ctx, args as never)
      },
    }
  })
}

/** The rows the manifest fingerprints: name / description / parameters of the named tools. */
export function toolSchemaRows(names: string[]): { name: string; description: string; parameters: Record<string, unknown> }[] {
  const rows: { name: string; description: string; parameters: Record<string, unknown> }[] = []
  for (const name of names) {
    const spec = specOf(name)
    if (spec === null) continue
    rows.push({ name, description: spec.description, parameters: parametersSchema(spec) })
  }
  return rows
}

// the gate reads a tool's effect through the registry, never the other way round
setGateHooks({ effectOf: (name) => specOf(name)?.effect ?? null })
