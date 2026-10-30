import { posix } from 'node:path'
import type { Workspace } from '@oasis-code/contract'
import type { RemoteFiles } from '../workspace/remote_files.ts'
import { remoteBinding, remotePath } from '../workspace/remote_files.ts'
import { INSTRUCTION_FILES, SETTINGS_SOURCE, truncateBytes, type InstructionFile } from './project_instructions.ts'
import { RemoteRefused } from '../workspace/remote.ts'
import { instructionFingerprint } from './project_instructions.ts'
import { text, PROMPT_TEXT } from '../prompt_texts.ts'
import type { Ctx } from './tools/common.ts'

async function folder(files: RemoteFiles, ws: Workspace, dir: string): Promise<InstructionFile[]> {
  const output: InstructionFile[] = []
  for (const name of INSTRUCTION_FILES) {
    const path = posix.join(dir, name)
    const raw = await files.now(ws, path)
    if (raw === null) continue
    const cut = truncateBytes(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    output.push({ source: path, scope: dir === '.' ? 'the working folder' : dir + '/', priority: name, ...cut })
  }
  return output
}
export async function remoteInstructions(files: RemoteFiles, ws: Workspace, settings?: string): Promise<InstructionFile[]> {
  await files.remote.request(remoteBinding(ws), 'roots.validate', {})
  return [...(settings ? [{ source: SETTINGS_SOURCE, scope: 'the whole project', priority: SETTINGS_SOURCE, ...truncateBytes(settings) }] : []), ...await folder(files, ws, '.')]
}
export async function noteRemoteInstructions(ctx: Ctx, path: string): Promise<string | null> {
  const deps = ctx.deps, files = deps.workspaces.requireRemoteFiles(), rel = remotePath(deps.workspace, path)
  const parts = posix.dirname(rel).split('/').filter(p => p && p !== '.')
  if (parts.length > 32) throw new RemoteRefused('path_refused', 'Remote instruction scope exceeds the directory depth limit.')
  let pending: string | null = null
  for (let i = 1; i <= parts.length; i++) {
    for (const f of await folder(files, deps.workspace, parts.slice(0, i).join('/'))) {
      const version = instructionFingerprint(f.text)
      if (deps.instruction_versions.get(f.source) === version) { if (deps.instructions_pending.has(f.source)) pending = f.scope; continue }
      deps.instruction_scopes.add(f.source); deps.instruction_versions.set(f.source, version); deps.instructions_pending.add(f.source)
      deps.pending_notes.push(text('context.project', { source: f.source, scope: f.scope, text: f.text }))
      pending = f.scope
    }
  }
  if (pending) deps.pending_notes.push(PROMPT_TEXT['context.project_scope_rule'])
  return pending
}
