/** The run manifest (adapted from oasis agent/manifest.py, see NOTICE) — the fingerprints that make a run
 *  reproducible evidence rather than an anecdote. Every run seals, BEFORE its first model request, what actually
 *  went in: the person's request and the assembled first message, the fixed instructions, the exact tool schemas
 *  the model sees (the same fingerprint every request record carries), the model route (never a key), every input
 *  it was pointed at (project instruction files, the checkpoints / assets / runs an order refers to) with its hash, the locks, the workspace's base and tree, the grants, the
 *  budget, the isolation runtime, the host tools and the build. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { arch, platform, release } from 'node:os'
import { API_VERSION, MANIFEST_VERSION, SCHEMA_VERSION, type Grants } from '@oasis-code/contract'
import type { ModelConfig } from '../config.ts'
import { routeEndpoint, routeKeyEnv } from '../llm/catalog.ts'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { schemaRowsFingerprint } from '../llm/usage.ts'
import type { AssetStore } from '../store.ts'
import { backendIdentity } from '../version.ts'
import type { InstructionFile } from './project_instructions.ts'
import { surface } from './tools/registry.ts'
import type { WorkOrder } from './work_orders.ts'

export { MANIFEST_VERSION }

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

let hostCache: Record<string, unknown> | null = null

export function hostTools(): Record<string, unknown> {
  if (hostCache) return hostCache
  const version = (argv: string[]): string | null => {
    try {
      const out = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 10_000 })
      if (out.status !== 0) return null
      return (out.stdout || out.stderr).trim().split('\n')[0] ?? null
    } catch {
      return null
    }
  }
  hostCache = { git: version(['git', '--version']), bun: typeof Bun !== 'undefined' ? Bun.version : null, platform: `${platform()}-${release()}`, machine: arch() }
  return hostCache
}

/** Every input the run was pointed at, with what pins it: an instruction file's text sha, a checkpoint's commit,
 *  an asset's sha, a run's status; a reference that resolves to nothing says so. */
export function instructionFingerprints(files: InstructionFile[]): Record<string, unknown>[] {
  return files.map((f) => ({ kind: 'instruction_file', source: f.source, scope: f.scope, sha256: sha(f.text) }))
}

/** What differs between the instructions an earlier run was pointed at and these: the files added or rewritten
 *  since (to show), the sources gone (to name); null when the earlier manifest carries no inputs to compare. */
export function instructionDelta(previous: Record<string, unknown> | null | undefined, files: InstructionFile[]): { changed: InstructionFile[]; removed: string[] } | null {
  const inputs = previous && Array.isArray(previous.inputs) ? (previous.inputs as Record<string, unknown>[]) : null
  if (inputs === null) return null
  const before = new Map(inputs.filter((i) => i.kind === 'instruction_file').map((i) => [String(i.source), String(i.sha256)]))
  // the files the run was shown as it went (a folder entered, a file rewritten) count as seen, at that version
  for (const shown of Array.isArray(previous!.instructions_shown) ? (previous!.instructions_shown as Record<string, unknown>[]) : []) before.set(String(shown.source), String(shown.sha256))
  const changed = files.filter((f) => before.get(f.source) !== sha(f.text))
  const now = new Set(files.map((f) => f.source))
  const removed = [...before.keys()].filter((source) => !now.has(source))
  return { changed, removed }
}

/** Whether the instructions a run was pointed at differ from an earlier run's (its manifest's inputs): a source
 *  added, gone or rewritten. An earlier run whose manifest carries no inputs at all is not compared. */
export function instructionsChanged(previous: Record<string, unknown> | null | undefined, files: InstructionFile[]): boolean {
  const inputs = previous && Array.isArray(previous.inputs) ? (previous.inputs as Record<string, unknown>[]) : null
  if (inputs === null) return false
  const key = (f: Record<string, unknown>) => `${String(f.source)}\u0000${String(f.sha256)}`
  const before = inputs.filter((i) => i.kind === 'instruction_file').map(key).sort()
  const now = instructionFingerprints(files).map(key).sort()
  return before.join('\n') !== now.join('\n')
}

export function inputFingerprints(conn: Conn, _store: AssetStore, o: { project_id: string; instruction_files: InstructionFile[]; order: WorkOrder | null }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = instructionFingerprints(o.instruction_files)
  const refs: string[] = o.order ? [...o.order.context_refs] : []
  if (o.order && o.order.workspace.base !== 'parent') refs.push(o.order.workspace.base)
  for (const ref of [...new Set(refs)]) {
    const prefix = ref.split('_', 1)[0]
    let cp, asset, run, x
    if (prefix === 'cp' && (cp = repo.getCheckpoint(conn, ref)) !== null) out.push({ kind: 'checkpoint', id: ref, commit: cp.commit_sha })
    else if (prefix === 'a' && (asset = repo.getAsset(conn, ref)) !== null && asset.project_id === o.project_id) out.push({ kind: 'asset', id: ref, sha256: asset.sha256, role: asset.meta.role ?? null })
    else if (prefix === 'run' && (run = repo.getRun(conn, ref)) !== null) out.push({ kind: 'run', id: ref, status: run.status })
    else if (prefix === 'x' && (x = repo.getExecution(conn, ref)) !== null) out.push({ kind: 'execution', id: ref, exit_code: x.exit_code, stdout_asset_id: x.stdout_asset_id })
    else out.push({ kind: 'reference', id: ref, resolved: false })
  }
  return out
}

export interface ManifestInputs {
  run_id: string; session_id: string; project_id: string; workspace: Record<string, unknown>; instructions_text: string; prompt: string; model_cfg: ModelConfig;
  grants: Grants; project_instruction_sources: string[]; isolation: Record<string, unknown>; budget: Record<string, unknown>; history_from: string | null;
  handoff: Record<string, unknown> | null; tool_names?: string[] | null; work_order?: Record<string, unknown> | null;
  user_text?: string; tool_rows?: { name: string; description: string; parameters: Record<string, unknown> }[] | null;
  inputs?: Record<string, unknown>[] | null; locks?: Record<string, unknown>[] | null; thinking?: string | null; thinking_sent?: string | null
  /** the permission and restriction lines the first message showed (what a later run of the conversation compares against) */
  permissions?: string; restrictions?: string
}

export function buildRunManifest(m: ManifestInputs): Record<string, unknown> {
  const names = m.tool_names ?? null
  let tools = surface().filter((t) => names === null || names.includes(t.name))
  if (names !== null) tools = [...tools].sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name)) // the order the run's surface lists them in
  const cfg = m.model_cfg
  const prompt = m.prompt
  const instructions = m.instructions_text
  return {
    version: MANIFEST_VERSION, run_id: m.run_id, session_id: m.session_id, project_id: m.project_id,
    work_order: m.work_order ?? null, permissions: m.permissions ?? '', restrictions: m.restrictions ?? '',
    request_sha256: sha(m.user_text ?? ''), prompt_sha256: sha(prompt), prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
    instructions_sha256: sha(instructions), instructions_bytes: Buffer.byteLength(instructions, 'utf8'),
    tools: tools.map((t) => t.name), tool_effects: Object.fromEntries(tools.map((t) => [t.name, t.effect])),
    tool_schema_sha256: m.tool_rows ? schemaRowsFingerprint(m.tool_rows) : null,
    project_instruction_sources: m.project_instruction_sources,
    inputs: [...(m.inputs ?? [])], locks: [...(m.locks ?? [])],
    model: {
      id: cfg.id, provider: cfg.provider, configured_model: cfg.model, endpoint: routeEndpoint(cfg), api: cfg.api,
      credential_kind: cfg.auth === 'oauth' ? 'subscription sign-in' : 'key from the environment or the Accounts page', credential_env: routeKeyEnv(cfg),
      context_window: cfg.context_window, window_source: cfg.window_source, thinking: m.thinking ?? null, thinking_sent: m.thinking_sent ?? null,
    },
    workspace: m.workspace, grants: m.grants, isolation: m.isolation, budget: m.budget, history_from_run: m.history_from, handoff: m.handoff,
    host: hostTools(), build: backendIdentity(), schema_version_db: SCHEMA_VERSION, api_version: API_VERSION,
  }
}
