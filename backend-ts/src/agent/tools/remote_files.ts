/** Remote file-tool implementation; the shared permission/approval boundary remains in files.ts. */
import type { LockSpec, Workspace } from '@oasis-code/contract'
import type { WorkspaceService } from '../../workspace/service.ts'
import type { TextWrite } from './files.ts'
import { remoteBinding } from '../../workspace/remote_files.ts'
import { RemoteError } from '../../remote/types.ts'
import { RemoteOutcomeUnresolved, RemoteRefused } from '../../workspace/remote.ts'
import { checkChange } from '../../policy/locks.ts'
import { isBinary, sha256Of } from '../../workspace/reading.ts'
import { unifiedDiff } from '../../workspace/textdiff.ts'
import { newId } from '../../ids.ts'
import type { Payload } from './common.ts'

async function checkedRemoteText(workspaces: WorkspaceService, ws: Workspace, locks: LockSpec[], protectedPaths: string[], args: TextWrite,
  record: { session_id: string | null; run_id: string | null; tool_call_id: string | null; cancelled?: () => boolean }): Promise<[Payload, Record<string, unknown>, string | null]> {
  const files = workspaces.requireRemoteFiles()
  const refuse = (reason: string, code = 'refused'): [Payload, Record<string, unknown>, null] => [{ status: 'refused', reason, code }, { summary: reason }, null]
  // The remote filesystem decides case/Unicode aliases, including a leaf that does not exist yet.
  // Every positive is a deny/constraint; these results are never used to grant an allowlist.
  const expand = (p: string) => [p, p.endsWith('/**') ? p : p.replace(/\/$/, '') + '/**']
  const protectedPatterns = protectedPaths.flatMap(expand)
  const patterns = [...protectedPatterns, ...locks.flatMap(l => expand(l.path))]
  const matched = await files.remote.request(remoteBinding(ws), 'files.policyMatch', { path: args.path, patterns, allow_missing: true })
  if (matched.matches.length !== patterns.length || matched.matches.some(v => typeof v !== 'boolean')) return refuse('Remote policy result is inconsistent.', 'policy_semantics_unavailable')
  const rel = matched.path
  if (matched.matches.slice(0, protectedPatterns.length).some(Boolean)) return refuse('This remote path is protected.', 'path_refused')
  const applicableLocks = locks.filter((_lock, i) => matched.matches[protectedPatterns.length + i * 2] || matched.matches[protectedPatterns.length + i * 2 + 1])
  const before = await files.now(ws, rel)
  const version = before === null ? null : sha256Of(before)
  if (version !== args.expected_sha256) return refuse('The remote file must be read again before writing; its version differs.', 'version_conflict')
  if (before !== null && isBinary(before)) return refuse('Remote file tools edit UTF-8 text only.', 'file_type')
  const text = before === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(before)
  let after: string
  let replacements: number | null = null
  if (args.kind === 'edit') {
    if (text === null) return refuse('The remote file does not exist.', 'not_found')
    if (!args.old_string || args.new_string == null) return refuse('An edit requires old_string and new_string.')
    replacements = text.split(args.old_string).length - 1
    if (replacements === 0 || (replacements > 1 && !args.replace_all)) return refuse('The replacement must match once unless replace_all is selected.', 'version_conflict')
    after = args.replace_all ? text.split(args.old_string).join(args.new_string) : text.replace(args.old_string, () => args.new_string!)
  } else {
    if (args.content == null) return refuse('content is required.')
    after = args.content
  }
  const broken = checkChange(applicableLocks, rel, text, after, { paths_matched: true })
  if (broken.length) return [{ status: 'refused_by_lock', reason: broken.join('; '), path: rel, locks: broken }, { summary: broken.join('; ') }, null]
  const bytes = Buffer.from(after)
  await files.withLease(ws, record.run_id ?? newId('write'), async lease => {
    const current = await files.remote.request(remoteBinding(ws), 'files.policyMatch', { path: rel, patterns, allow_missing: true })
    if (current.path !== rel || current.matches.length !== patterns.length) throw new RemoteRefused('policy_semantics_unavailable', 'Remote policy identity changed before the write.')
    if (current.matches.slice(0, protectedPatterns.length).some(Boolean)) throw new RemoteRefused('path_refused', 'This remote path is protected.')
    const currentLocks = locks.filter((_lock, i) => current.matches[protectedPatterns.length + i * 2] || current.matches[protectedPatterns.length + i * 2 + 1])
    const violations = checkChange(currentLocks, rel, text, after, { paths_matched: true })
    if (violations.length) throw new RemoteRefused('refused_by_lock', violations.join('; '))
    return files.write(ws, rel, bytes, version, record, lease)
  })
  workspaces.noteWrite(ws)
  const diff = unifiedDiff(text ?? '', after, rel).slice(0, 20_000)
  const action = before === null ? 'created' : args.kind === 'edit' ? 'edited' : 'overwritten'
  return [{ status: 'ok', path: rel, action, diff, ...(replacements === null ? {} : { replacements }) }, { path: rel, op: action, diff }, sha256Of(bytes)]
}

export async function writeRemoteText(...args: Parameters<typeof checkedRemoteText>): ReturnType<typeof checkedRemoteText> {
  try { return await checkedRemoteText(...args) }
  catch (error) {
    // a write whose outcome stays unknown is no answer of this call's: its caller stops the run (files.ts)
    if (error instanceof RemoteOutcomeUnresolved) throw error
    if (error instanceof RemoteError || error instanceof RemoteRefused) {
      const uncertain = error instanceof RemoteError ? error.status === 'unknown' || error.status === 'disconnected' : error.status >= 500
      const status = uncertain ? 'unknown' : error.code === 'refused_by_lock' ? 'refused_by_lock' : 'refused'
      return [{ status, code: error.code, reason: error.message }, { summary: error.message, code: error.code }, null]
    }
    throw error
  }
}
