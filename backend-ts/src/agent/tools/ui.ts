/** present_ui: the agent shows the person an interactive surface (contract/src/ui.ts) — the complete spec each call,
 *  validated whole before anything is written or shown. A surface changes nothing outside the conversation (no file,
 *  no command, no network from the harness), so it is a read in the permission layer's terms: Plan mode keeps it,
 *  and it needs no approval. What the provider is sent back is a few fields (never the spec or its document); the
 *  surface itself goes to the thread as a `ui_surface` event and stays in the session's records.
 *
 *  read_ui: the calling run reads a surface's published snapshot back — its own (`run`), or its session's main-thread
 *  surface (`session`, for a main-thread run only): the spec as last published, its revision, scope, runs, model and
 *  times, never the person's current values (contract uiReadSnapshot); the thread's row, the transcript and a peer's
 *  packet keep to which surface and revision. Neither tool takes a session or a run: what is reached follows from the calling run. */

import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  checkUiJson, splitUiPublishArgs, UI_ACTION_MODES, UI_ELEMENT_TYPES, UI_LIMITS, UI_SPEC_VERSION, UI_SURFACE_SCOPES, UiReadArgsSchema, UiReadResultSchema, z,
  type UiReadResult,
} from '@oasis-code/contract'
import * as repo from '../../db/repo.ts'
import { PROMPT_TEXT, text } from '../../prompt_texts.ts'
import { presentSurface, readSurface } from '../ui_surfaces.ts'
import { finish, orderRefused, type Ctx, type Payload } from './common.ts'
import { register } from './registry.ts'
import { ownedExecution } from './commands.ts'

const P = (key: string) => PROMPT_TEXT[`parameter.present_ui.${key}` as keyof typeof PROMPT_TEXT]

/** What the model is told the arguments are: flat (no recursion, so every provider's schema dialect takes it) and
 *  loose (an unknown key reaches the full check, which names it, instead of being dropped here). The spec itself is
 *  checked by parseUiSurfaceSpec. */
export const ElementArgSchema = z.looseObject({
  type: z.enum(UI_ELEMENT_TYPES),
  props: z.record(z.string(), z.unknown()).optional(),
  children: z.array(z.string()).optional(),
})

export const PresentUiArgsSchema = z.looseObject({
  version: z.number().int().default(UI_SPEC_VERSION).describe(P('version')),
  surface_id: z.string().describe(P('surface_id')),
  title: z.string().describe(P('title')),
  fallback: z.string().describe(P('fallback')),
  kind: z.enum(['native', 'html']).describe(P('kind')),
  initial_state: z.record(z.string(), z.unknown()).nullable().optional().describe(P('initial_state')),
  // `mode` (draft | run) is kept for parseUiSurfaceSpec; an action without one (or with null) is a draft action
  actions: z.array(z.object({ id: z.string(), label: z.string(), prompt: z.string(), mode: z.enum(UI_ACTION_MODES).nullable().optional() })).nullable().optional().describe(P('actions')),
  root: z.string().nullable().optional().describe(P('root')),
  elements: z.record(z.string(), ElementArgSchema).nullable().optional().describe(P('elements')),
  html: z.string().nullable().optional().describe(P('html')),
  html_file: z.string().nullable().optional().describe(P('html_file')),
  // how the call publishes (contract UiPublishOptions), never part of the spec: splitUiPublishArgs takes them out
  scope: z.enum(UI_SURFACE_SCOPES).nullable().optional().describe(P('scope')),
  expected_revision: z.number().int().min(0).nullable().optional().describe(P('expected_revision')),
})
export type PresentUiArgs = z.infer<typeof PresentUiArgsSchema>

/** The top-level arguments the tool's schema declares nullable: a null there is the field left out (a provider that
 *  sends every field sends null). A null anywhere else stays, for the spec's check to refuse. */
const NULLABLE_ARGS: ReadonlySet<string> = new Set(['initial_state', 'actions', 'root', 'elements', 'html', 'html_file', 'scope', 'expected_revision'])

/** The arguments as a spec: a declared nullable field left null (and an action's null mode) is a field left out.
 *  The container has no prototype, so every key the call sent — `__proto__` included, whatever its value — stays an
 *  own key the spec's check sees and refuses by name (a plain object's `__proto__` setter would swallow it). */
export function specOfArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || (v === null && NULLABLE_ARGS.has(k))) continue
    out[k] = v
  }
  // an action's mode left null is a mode left out (the draft default), as a top-level null is a field left out
  if (Array.isArray(out.actions)) {
    out.actions = out.actions.map((a: unknown) => {
      if (a === null || typeof a !== 'object' || Array.isArray(a) || (a as Record<string, unknown>).mode !== null) return a
      const { mode: _mode, ...rest } = a as Record<string, unknown>
      return rest
    })
  }
  return out
}

/** A file's bytes read as an html document may be at most this many: a UTF-8 character is at most four bytes, so a
 *  file past it is past the document's character limit whatever it holds (refused before it is read whole). */
const HTML_FILE_MAX_BYTES = UI_LIMITS.htmlChars * 4

/** `html_file`: the document read from the working folder when the call is made, as `read_file` reads (the folder's
 *  bounds, protected paths and a work order's read scope), into the spec's `html`. The spec stored is the same as an
 *  inline one: the surface keeps the document as it was, whatever the file becomes after. */
function withFileDocument(ctx: Ctx, spec: Record<string, unknown>): { spec: Record<string, unknown> } | { errors: string[] } | { refused: Payload } {
  const path = spec.html_file
  if (path === undefined) return { spec }
  const rest = { ...spec }
  delete rest.html_file
  if (typeof path !== 'string' || !path.trim()) return { errors: ['html_file must name a file in the working folder'] }
  if (spec.kind !== 'html') return { errors: ['html_file is for kind html'] }
  if (spec.html !== undefined) return { errors: ['give html or html_file, not both'] }
  const blocked = orderRefused(ctx, 'present_ui', { path })
  if (blocked !== null) return { refused: blocked }
  let real: string
  try { real = ctx.deps.policy.resolveRead(path)[1] } catch (e) { return { errors: [`html_file ${path} cannot be read: ${e instanceof Error ? e.message : String(e)}`] } }
  try {
    const st = statSync(real)
    if (!st.isFile()) return { errors: [`html_file ${path} is not a file`] }
    if (st.size > HTML_FILE_MAX_BYTES) return { errors: [`html_file ${path} is ${st.size} bytes; a document is at most ${UI_LIMITS.htmlChars} characters`] }
    return { spec: { ...rest, html: readFileSync(real, 'utf8') } }
  } catch (e) {
    return { errors: [`html_file ${path} cannot be read: ${e instanceof Error ? e.message : String(e)}`] }
  }
}

/** A chart's file `source`: its path is checked when the call is made as read_file checks it (the working folder's
 *  bounds, protected paths, a work order's read scope; an SSH workspace's path resolved on the host). A file not there
 *  yet is accepted (the chart waits for it); a path the run may not read is not. The file's contents are never read
 *  here: the app reads them while the surface is shown (agent/ui_chart_sources.ts), under the same bounds again. */
async function checkChartSources(ctx: Ctx, spec: Record<string, unknown>): Promise<{ errors: string[] } | { refused: Payload } | null> {
  const elements = spec.elements
  if (spec.kind !== 'native' || elements === null || typeof elements !== 'object' || Array.isArray(elements)) return null
  const errors: string[] = []
  for (const [id, el] of Object.entries(elements as Record<string, unknown>)) {
    const props = (el as { type?: unknown; props?: { source?: { path?: unknown; progress?: { execution_id?: unknown } } } } | null)
    if (props?.type !== 'chart' && props?.type !== 'progress') continue
    const executionId = props.props?.source?.progress?.execution_id
    if (typeof executionId === 'string' && ownedExecution(ctx.deps, executionId) === null) errors.push(`elements.${id}.props.source.progress.execution_id: unknown command`)
    const path = props.props?.source?.path
    if (typeof path !== 'string' || !path.trim()) continue
    const blocked = orderRefused(ctx, 'present_ui', { path })
    if (blocked !== null) return { refused: blocked }
    try {
      if (ctx.deps.workspace.target?.kind === 'ssh') {
        const resolved = await ctx.deps.workspaces.requireRemoteFiles().resolve(ctx.deps.workspace, path, true)
        const canonical = orderRefused(ctx, 'present_ui', { path: resolved.path })
        if (canonical !== null) return { refused: canonical }
        if (resolved.exists && resolved.kind !== 'file') errors.push(`elements.${id}.props.source.path: ${path} is not a regular file`)
      } else {
        const real = ctx.deps.policy.resolveRead(path)[1]
        // the order's scope on what the path resolved to too (a link inside the folder to a place out of the scope)
        const canonical = ctx.deps.policy.canonicalOf(real)
        if (!canonical.temp && canonical.path !== null && canonical.path !== path) {
          const resolvedBlocked = orderRefused(ctx, 'present_ui', { path: canonical.path })
          if (resolvedBlocked !== null) return { refused: resolvedBlocked }
        }
        if (existsSync(real) && !statSync(real).isFile()) errors.push(`elements.${id}.props.source.path: ${path} is not a regular file`)
      }
    } catch (e) {
      errors.push(`elements.${id}.props.source.path: ${path} cannot be read: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return errors.length ? { errors } : null
}

export async function presentUiTool(ctx: Ctx, args: PresentUiArgs): Promise<Payload> {
  const deps = ctx.deps
  const run = repo.getRun(deps.conn, deps.run_id)
  // the publishing options first (scope, expected_revision), out of what becomes the spec
  const split = splitUiPublishArgs(args as Record<string, unknown>)
  const filed = withFileDocument(ctx, specOfArgs(split.spec))
  if ('refused' in filed) return filed.refused
  const sources = 'spec' in filed ? await checkChartSources(ctx, filed.spec) : null
  if (sources !== null && 'refused' in sources) return sources.refused
  const result = !split.options.ok ? { ok: false as const, errors: split.options.errors }
    : 'errors' in filed ? { ok: false as const, errors: filed.errors }
    : sources !== null ? { ok: false as const, errors: sources.errors }
    : presentSurface(deps.conn, { session_id: deps.session.id, run_id: deps.run_id, model: run?.model ?? null }, filed.spec, split.options.value)
  if (!result.ok) {
    if ('conflict' in result) {
      const c = result.conflict
      const payload = { ...c, message: text('ui.conflict', { surface_id: c.surface_id, expected: c.expected_revision, current: c.current_revision ?? 'none' }) }
      return finish(ctx, 'present_ui', payload, { summary: `not shown: ${result.errors[0] ?? 'conflict'}`.slice(0, 200), surface_id: c.surface_id, scope: c.scope, revision: c.current_revision })
    }
    if ('refused' in result) {
      const payload = { status: 'refused', scope: 'session', reason: result.refused, message: text('ui.session_refused', { reason: result.refused }) }
      return finish(ctx, 'present_ui', payload, { summary: `not shown: ${result.refused}`.slice(0, 200), scope: 'session' })
    }
    const errors = result.errors.map((e) => `- ${e}`).join('\n')
    const payload = { status: 'invalid', errors: result.errors, message: text('ui.invalid', { errors }) }
    return finish(ctx, 'present_ui', payload, { summary: `not shown: ${result.errors[0] ?? 'invalid'}`.slice(0, 200) })
  }
  const s = result.surface
  // the thread's block, live and in the run's events (replay, reconnect); the tool's own row stays a summary. The
  // event is this run's (the writer); the record's run_id is the surface's anchor, updated_by_run_id this run
  deps.emit('ui_surface', { surface: s })
  const session = s.scope === 'session'
  const payload = {
    status: 'ok', surface_id: s.surface_id, revision: s.revision, kind: s.spec.kind,
    // a session surface says so (a run surface's answer is as it always was)
    ...(session ? { scope: 'session' } : {}),
    message: text('ui.presented', { surface_id: s.surface_id, revision: s.revision }),
  }
  return finish(ctx, 'present_ui', payload, { summary: `${s.spec.title} (revision ${s.revision})`.slice(0, 200), surface_id: s.surface_id, revision: s.revision, ...(session ? { scope: 'session' } : {}) })
}

const R = (key: string) => PROMPT_TEXT[`parameter.read_ui.${key}` as keyof typeof PROMPT_TEXT]

/** read_ui's arguments as the model is told them: flat; no session or run (what can be read follows from the calling
 *  run). Strict: a key it does not take is refused by name, never dropped. */
export const ReadUiArgsSchema = z.strictObject({
  surface_id: z.string().describe(R('surface_id')),
  scope: z.enum(UI_SURFACE_SCOPES).nullable().optional().describe(R('scope')),
})
export type ReadUiArgs = z.infer<typeof ReadUiArgsSchema>

/** What a read_ui answer leaves in the thread's row (and so in the events, a replay, a transcript): which surface, at
 *  which revision, of which scope — never its spec, its document or its values. */
export function readUiSummary(r: UiReadResult): Record<string, unknown> {
  if (r.status === 'ok') return { summary: `${r.surface.surface_id} (${r.surface.scope ?? 'run'}, revision ${r.surface.revision})`, surface_id: r.surface.surface_id, scope: r.surface.scope ?? 'run', revision: r.surface.revision }
  if (r.status === 'not_found') return { summary: `not found: ${r.surface_id}`.slice(0, 200), surface_id: r.surface_id, scope: r.scope }
  return { summary: `refused: ${r.reason}`.slice(0, 200), scope: r.scope }
}

export async function readUiTool(ctx: Ctx, args: ReadUiArgs): Promise<Payload> {
  const deps = ctx.deps
  const parsed = UiReadArgsSchema.safeParse(args)
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`)
    return finish(ctx, 'read_ui', { status: 'invalid', errors }, { summary: `invalid: ${errors[0] ?? ''}`.slice(0, 200) })
  }
  const result = readSurface(deps.conn, { session_id: deps.session.id, run_id: deps.run_id }, parsed.data)
  // the answer as the contract has it (a snapshot: no state key); anything else is not handed to the model
  const checked = UiReadResultSchema.safeParse(result)
  if (!checked.success) return finish(ctx, 'read_ui', { status: 'error', message: 'the surface could not be read' }, { summary: 'error: the answer did not match its contract' })
  // the calling run gets the snapshot whole; the thread's row only its summary
  return finish(ctx, 'read_ui', result as unknown as Payload, readUiSummary(result))
}

register({
  name: 'present_ui', effect: 'read', action: null, renderer: 'generic', summary: 'show the person an interactive surface',
  description: PROMPT_TEXT['tool.present_ui'],
  schema: PresentUiArgsSchema, fn: presentUiTool,
  // a reserved key (`__proto__`, `constructor`, …) anywhere in the spec is refused by name, never silently dropped
  precheck: (args) => checkUiJson(args),
})

register({
  name: 'read_ui', effect: 'read', action: null, renderer: 'generic', summary: 'read a surface’s published snapshot',
  description: PROMPT_TEXT['tool.read_ui'],
  schema: ReadUiArgsSchema, fn: readUiTool,
})
