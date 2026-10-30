/** The director tool surfaces, as data. A director conversation (a native director session; a ChatGPT connector, by
 *  the URL it was given) keeps one surface for every request it makes: the tool list — names, descriptions, JSON
 *  schemas —, the system instructions and the texts the harness writes into it never change under it, so the
 *  conversation stays append-only and its prompt cache stays warm. Each surface is a committed snapshot
 *  (director.v1.json: the bytes of main 3d06c7b; director.v2.json: the v25 merge's; director.v3.json: 73c55f3's; director.v4.json: 5183bc0's; director.v5.json: ba2e5e5's; director.v6.json: 5aa828f's; director.v7.json: 55b8bd7's; director.v8.json: c738506's; director.v9.json: 7c487d8's; director.v10.json: 0ace48c's; director.v11.json: this tree's), read here as data and never
 *  regenerated from zod or the SDK at runtime: a library upgrade or an edit of a schema cannot reach a held
 *  conversation. A new capability is a new surface. */

import { createHash } from 'node:crypto'
import { CURRENT_DIRECTOR_TOOL_SURFACE, DIRECTOR_TOOL_SURFACES, directorToolSurfaceOf, type DirectorToolSurface } from '@oasis-code/contract'
import { PROMPT_TEXT, type PromptKey } from '../../prompt_texts.ts'
import V1 from './director.v1.json' with { type: 'json' }
import V2 from './director.v2.json' with { type: 'json' }
import V3 from './director.v3.json' with { type: 'json' }
import V4 from './director.v4.json' with { type: 'json' }
import V5 from './director.v5.json' with { type: 'json' }
import V6 from './director.v6.json' with { type: 'json' }
import V7 from './director.v7.json' with { type: 'json' }
import V8 from './director.v8.json' with { type: 'json' }
import V9 from './director.v9.json' with { type: 'json' }
import V10 from './director.v10.json' with { type: 'json' }
import V11 from './director.v11.json' with { type: 'json' }

type Rec = Record<string, unknown>

export interface NativeToolDef { name: string; description: string; parameters_json_schema: Rec }
export interface SurfaceSnapshot {
  surface: DirectorToolSurface
  note: string
  connector: { instructions: string; tools: Rec[] }
  native: { instructions: string; tools: NativeToolDef[] }
  templates: Record<string, string>
  golden: Record<string, string>
  sha256: Record<string, string>
}

export { CURRENT_DIRECTOR_TOOL_SURFACE, DIRECTOR_TOOL_SURFACES }
export type { DirectorToolSurface }

const SNAPSHOTS: Record<DirectorToolSurface, SurfaceSnapshot> = {
  'director.v1': V1 as unknown as SurfaceSnapshot,
  'director.v2': V2 as unknown as SurfaceSnapshot,
  'director.v3': V3 as unknown as SurfaceSnapshot,
  'director.v4': V4 as unknown as SurfaceSnapshot,
  'director.v5': V5 as unknown as SurfaceSnapshot,
  'director.v6': V6 as unknown as SurfaceSnapshot,
  'director.v7': V7 as unknown as SurfaceSnapshot,
  'director.v8': V8 as unknown as SurfaceSnapshot,
  'director.v9': V9 as unknown as SurfaceSnapshot,
  'director.v10': V10 as unknown as SurfaceSnapshot,
  'director.v11': V11 as unknown as SurfaceSnapshot,
}

/** The sha256 of a snapshot part, as the snapshot computes it (a string's bytes, else its JSON). */
export function surfaceDigest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

export function snapshotOf(surface: DirectorToolSurface): SurfaceSnapshot {
  const snap = SNAPSHOTS[surface]
  if (!snap) throw new Error(`unknown director tool surface: ${surface}`)
  return snap
}

/** The surface a director session's conversation holds: its config's, else v1 (a session opened before surfaces). */
export function surfaceOf(ds: { config?: Rec | null } | null | undefined): DirectorToolSurface {
  const named = ds?.config?.tool_surface
  // Absence denotes a legacy conversation. An explicit unknown version denotes a frame this build cannot replay;
  // it must not silently change that conversation to v1 on the next model request.
  if (named !== undefined && named !== null && (typeof named !== 'string' || !(DIRECTOR_TOOL_SURFACES as readonly string[]).includes(named))) {
    throw new Error(`unsupported director tool surface: ${String(named)}; this conversation's recorded surface cannot be replayed by this build`)
  }
  return directorToolSurfaceOf(ds?.config ?? null)
}

export function nativeToolDefs(surface: DirectorToolSurface): NativeToolDef[] { return snapshotOf(surface).native.tools }
export function nativeInstructionsFor(surface: DirectorToolSurface): string { return snapshotOf(surface).native.instructions }
export function connectorToolsFor(surface: DirectorToolSurface): Rec[] { return snapshotOf(surface).connector.tools }
export function connectorInstructionsFor(surface: DirectorToolSurface): string { return snapshotOf(surface).connector.instructions }

/** A harness-written text of the conversation, from the surface's snapshot, its placeholders filled. A key is named
 *  by its v1 name (`director.task_event`); the v2 snapshot holds the v2 text under it. */
export function surfaceText(surface: DirectorToolSurface, key: string, vars: Record<string, string | number> = {}): string {
  const template = snapshotOf(surface).templates[key]
  if (template === undefined) throw new Error(`surface ${surface} has no text ${key}`)
  return template.replace(/\{([a-z_]+)\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`surface text ${key}: no value for {${name}}`)
    return String(vars[name])
  })
}

/** The native tools of a surface whose description or schema differ between audiences are generated once per
 *  audience (the server takes `audience`); which tools a native director does not get: */
export const NATIVE_EXCLUDED_BY_SURFACE: Record<DirectorToolSurface, ReadonlySet<string>> = {
  'director.v1': new Set(['current_session', 'post_director_note', 'open_project', 'create_session', 'list_projects', 'attach_image', 'bash']),
  'director.v2': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash']),
  'director.v3': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash']),
  'director.v4': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash']),
  'director.v5': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash']),
  'director.v6': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash']),
  'director.v7': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash']),
  'director.v8': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash', 'list_ssh_targets', 'ssh_directories', 'forward_port']),
  'director.v9': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash', 'list_ssh_targets', 'connect_ssh', 'ssh_directories', 'forward_port']),
  'director.v10': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash', 'list_ssh_targets', 'connect_ssh', 'ssh_directories', 'forward_port']),
  'director.v11': new Set(['current_session', 'post_director_note', 'open_project', 'list_projects', 'attach_image', 'bash', 'list_ssh_targets', 'connect_ssh', 'ssh_directories', 'forward_port']),
}

/** The tools that start or change work: refused in a report-only turn (the end of an isolated interaction). */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['start_run', 'start_relay', 'start_interaction', 'schedule', 'integrate', 'set_project_config', 'cancel_run', 'create_session', 'steer_run'])

// ---- what the snapshot script composes for a new surface (never read at runtime: the snapshot is) -----------------

// director.v3 to v8 write the same texts as v2 (their additions are a tool and descriptions, not harness-written lines)
const TEMPLATE_KEYS: Record<string, PromptKey> = {
  'director.context': 'director.v2.context',
  'director.envelope': 'director.v2.envelope',
  'director.task_event': 'director.v2.task_event',
  'director.person_runs': 'director.v2.person_runs',
  'director.plan': 'director.v2.plan',
  'director.plan_title': 'director.v2.plan_title',
  'director.plan_in_place': 'director.plan_in_place',
  'director.plan_images': 'director.plan_images',
  'director.decide': 'director.v2.decide',
  'director.decide_step': 'director.decide_step',
  'director.plan_none': 'director.plan_none',
  'director.interaction_question': 'director.interaction_question',
  'director.native_wait_refusal': 'director.v2.native_wait_refusal',
  'director.session_refusal': 'director.v2.session_refusal',
  'director.report_only_refusal': 'director.v2.report_only_refusal',
  'director.destructive_refusal': 'director.v2.destructive_refusal',
  'director.project_refusal': 'director.v2.project_refusal',
}

export function composeNativeInstructions(surface: DirectorToolSurface): string {
  if (surface !== 'director.v11') throw new Error(`${surface} is a frozen snapshot: it is read, never composed`)
  // a native director posts no note and runs no command: v4 to v7 say nothing new to it; v8 says what a remote workspace is; v9 to v11 nothing new
  return PROMPT_TEXT['director.v3.native'] + '\n\n' + PROMPT_TEXT['director.v8.remote']
}

export function composeTemplates(surface: DirectorToolSurface): Record<string, string> {
  if (surface !== 'director.v11') throw new Error(`${surface} is a frozen snapshot: it is read, never composed`)
  return Object.fromEntries(Object.entries(TEMPLATE_KEYS).map(([name, key]) => [name, PROMPT_TEXT[key]]))
}
