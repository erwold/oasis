import { binaryFileKind } from '../../llm/files.ts'
/** File tools: read (a file, numbered and paged; an image file, as an image the model sees; or a directory's listing),
 *  write, edit. Every path goes through the
 *  workspace's path policy. The harness remembers the version of each file this run read or wrote; a write over an
 *  existing file needs that version to be the file's current one (a file the run never read, or one that changed
 *  since, is refused, never overwritten) and the session's workspace_write grant. */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { saveAttachment } from '../../api/attachments.ts'
import * as repo from '../../db/repo.ts'
import { checkImageBytes, ImageRefused, imageToolPiece, MAX_IMAGE_BYTES, sniffImage } from '../../llm/images.ts'
import { z, type LockSpec, type Workspace } from '@oasis-code/contract'
import { checkActionGate, setGateHooks } from '../../policy/gate.ts'
import { checkChange } from '../../policy/locks.ts'
import { atomicWrite, WriteConflict } from '../../store.ts'
import { PathPolicy, PathRefused, posixOf } from '../../workspace/paths.ts'
import { rootPolicyOptionsOf } from '../../workspace/roots.ts'
import { unifiedDiff } from '../../workspace/textdiff.ts'
import { listWorkspaceFiles, readWorkspaceFile } from '../../workspace/reading.ts'
import { type WorkspaceService, workspaceAttached, isDirect } from '../../workspace/service.ts'
import { refreshSession, rootOf } from '../deps.ts'
import { finish, heldForInstructions, isBinary, noteFolderInstructions, orderRefused, refused, sha256Of, type Ctx, type Payload } from './common.ts'
import { PROMPT_TEXT, text as promptText } from '../../prompt_texts.ts'
import { register } from './registry.ts'
import { remoteBinding, remotePath } from '../../workspace/remote_files.ts'
import { noteRemoteInstructions } from '../remote_instructions.ts'
import { writeRemoteText } from './remote_files.ts'
import { RemoteError } from '../../remote/types.ts'
import { RemoteOutcomeUnresolved, RemoteRefused } from '../../workspace/remote.ts'
import { RunHalted } from '../loop.ts'

const DIFF_CAP = 20_000

/** A remote mutation whose reply was lost and whose receipt could not be read: the call answers with what is known —
 *  sent once, not sent again, outcome unknown — and the run stops here (no later call of this response, no request).
 *  The journal entry and the writer's lease stay open until a reconciliation reads the receipt. */
export function haltOnUnresolved(ctx: Ctx, tool: string, error: RemoteOutcomeUnresolved): never {
  const d = error.detail
  const payload = { status: 'unknown', code: 'outcome_unknown', reason: error.message, operation_id: d.operation_id, receipt_state: d.receipt_state,
    ...(d.path ? { path: d.path } : {}), ...(d.execution_id ? { execution_id: d.execution_id } : {}), sent_again: false }
  finish(ctx, tool, payload, { summary: error.message.slice(0, 200), code: 'outcome_unknown' })
  throw new RunHalted(payload, error.message)
}

function remoteFileFailure(ctx: Ctx, tool: string, error: unknown): Payload {
  if (error instanceof RemoteOutcomeUnresolved) haltOnUnresolved(ctx, tool, error)
  if (ctx.deps.workspace.target?.kind === 'ssh' && (error instanceof RemoteError || error instanceof RemoteRefused)) {
    const uncertain = error instanceof RemoteError ? error.status === 'unknown' || error.status === 'disconnected' : error.status >= 500
    return finish(ctx, tool, { status: uncertain ? 'unknown' : 'refused', code: error.code, reason: error.message }, { summary: error.message, code: error.code })
  }
  throw error
}
export function readFile(ctx: Ctx, args: { path: string; offset: number; limit: number }): Promise<Payload> {
  return readFileImpl(ctx, args).catch(error => remoteFileFailure(ctx, 'read_file', error))
}
async function readFileImpl(ctx: Ctx, args: { path: string; offset: number; limit: number }): Promise<Payload> {
  const deps = ctx.deps
  const blocked = orderRefused(ctx, 'read_file', { path: args.path })
  if (blocked !== null) return blocked
  if (deps.workspace.target?.kind === 'ssh') {
    const files = deps.workspaces.requireRemoteFiles(), path = (await files.resolve(deps.workspace, args.path)).path
    const canonicalBlocked = orderRefused(ctx, 'read_file', { path })
    if (canonicalBlocked) return canonicalBlocked
    const stat = await files.remote.request(remoteBinding(deps.workspace), 'files.stat', { path })
    await noteRemoteInstructions(ctx, stat.kind === 'directory' ? path + '/_' : path)
    if (stat.kind === 'directory') {
      const listing = await files.list(deps.workspace, path, Math.max(0, args.offset - 1), args.limit)
      return finish(ctx, 'read_file', { ...listing, kind: 'directory', files: listing.entries.map(e => e.path), offset: args.offset, next_offset: listing.next_offset === null ? null : listing.next_offset + 1 })
    }
    const data = await files.raw(deps.workspace, path, MAX_IMAGE_BYTES)
    if (sniffImage(data) !== null) {
      checkImageBytes(data.length)
      const attachment = saveAttachment({ conn: deps.conn, store: deps.store }, deps.session, data, basename(path))
      return finish(ctx, 'read_file', { status: 'ok', path, kind: 'image', media_type: attachment.media_type, width: attachment.width, height: attachment.height, bytes: attachment.bytes, image: imageToolPiece(attachment, deps.model_cfg.capabilities) })
    }
    const read = await files.read(deps.workspace, path, args.offset, args.limit)
    deps.seen.set(path, read.sha256)
    return finish(ctx, 'read_file', { ...read, next_offset: read.next_offset_line })
  }
  let isDir = false
  try {
    const [pure, real] = deps.policy.resolveRead(args.path)
    isDir = statSync(real).isDirectory()
    noteFolderInstructions(ctx, pure, real)
  } catch { isDir = false }
  if (isDir) {
    // a folder pages like a file: offset is the 1-based entry to start at, limit the entries of the page
    const offset = Math.max(1, Math.trunc(Number(args.offset)) || 1)
    const listing = listWorkspaceFiles(deps.policy, await deps.workspaces.listFiles(deps.workspace), rootOf(deps), args.path, Math.min(args.limit, 300), offset - 1)
    if (listing.status !== 'ok') return refused(ctx, 'read_file', listing.reason)
    const payload = {
      status: 'ok', path: listing.path, kind: 'directory', files: listing.entries.map((e) => e.path), count: listing.count, offset, truncated: listing.truncated,
      next_offset: listing.truncated ? offset + listing.entries.length : null,
    }
    return finish(ctx, 'read_file', payload, { path: listing.path, count: listing.count, truncated: listing.truncated })
  }
  const image = await readImageFile(ctx, args.path)
  if (image !== null) return image
  const read = readWorkspaceFile(deps.policy, args.path, args.offset, args.limit)
  if (read.status !== 'ok') return refused(ctx, 'read_file', read.reason)
  deps.seen.set(read.path, read.sha256)
  const payload = {
    status: 'ok', path: read.path, total_lines: read.total_lines, from_line: read.from_line, to_line: read.to_line, truncated: read.truncated,
    next_offset: read.next_offset_line, content: read.content,
  }
  return finish(ctx, 'read_file', payload, { path: read.path, lines: `${read.from_line}-${read.to_line}/${read.total_lines}`, truncated: read.truncated })
}

/** A PNG, JPEG or WebP file (by its first bytes, whatever its name) read as an image: its bytes copied into the
 *  session's assets as an attachment — the upload's path and limit, content-addressed, so the reference keeps these
 *  bytes after the file is overwritten — and the reference returned for the model to see. Null for any other file
 *  (or a path the text read refuses with its own reason). */
async function readImageFile(ctx: Ctx, path: string): Promise<Payload | null> {
  const deps = ctx.deps
  let pure: string[]
  let real: string
  try { [pure, real] = deps.policy.resolveRead(path) } catch { return null }
  let size: number
  const head = new Uint8Array(16)
  try {
    const st = statSync(real)
    if (!st.isFile()) return null
    size = st.size
    const fd = openSync(real, 'r')
    try { readSync(fd, head, 0, head.length, 0) } finally { closeSync(fd) }
  } catch {
    return null
  }
  if (binaryFileKind(head)) return refused(ctx, 'read_file', `read_file returns text and images; ${posixOf(pure)} is a PDF or video file`)
  if (sniffImage(head) === null) return null
  const rel = posixOf(pure)
  let attachment
  try {
    checkImageBytes(size)
    attachment = saveAttachment({ conn: deps.conn, store: deps.store }, deps.session, new Uint8Array(readFileSync(real)), basename(rel))
  } catch (error) {
    if (error instanceof ImageRefused) return refused(ctx, 'read_file', `'${rel}': ${error.message}`)
    throw error
  }
  const payload = {
    status: 'ok', path: rel, kind: 'image', media_type: attachment.media_type, width: attachment.width, height: attachment.height, bytes: attachment.bytes,
    image: imageToolPiece(attachment, deps.model_cfg.capabilities),
  }
  return finish(ctx, 'read_file', payload, { path: rel, media_type: attachment.media_type, width: attachment.width, height: attachment.height, bytes: attachment.bytes,
    shown: [{ asset_id: attachment.asset_id, width: attachment.width, height: attachment.height, label: rel }] })
}

/** One text write: the whole file (`write`), or one exact replacement in it (`edit`). `expected_sha256` is the version
 *  the writer saw of an existing file (null: never seen); a new file needs none. */
export interface TextWrite {
  path: string; kind: 'write' | 'edit'; expected_sha256: string | null
  content?: string | null; old_string?: string | null; new_string?: string | null; replace_all?: boolean
}

/** The one write path for a text file — the tools' and an approved proposal's: the path policy, the version
 *  precondition, the hard locks on the resulting bytes, the atomic write. Returns [payload, summary, version]: a
 *  refusal is status=refused (refused_by_lock for a lock) with the reason and no version; nothing is written unless
 *  status=ok, and then `version` is the sha256 of what was written. */
export function writeText(policy: PathPolicy, workspaces: WorkspaceService, workspace: Workspace, locks: LockSpec[], args: TextWrite,
  record: { session_id: string | null; run_id: string | null; tool_call_id: string | null } = { session_id: null, run_id: null, tool_call_id: null }): [Payload, Record<string, unknown>, string | null] {
  const refuse = (reason: string, status = 'refused', extra: Record<string, unknown> = {}): [Payload, Record<string, unknown>, null] =>
    [{ status, reason, ...extra }, { summary: reason.slice(0, 200), ...('path' in extra ? { path: extra.path } : {}) }, null]
  let pure: string[]
  let real: string
  try {
    ;[pure, real] = policy.resolveWrite(args.path)
  } catch (error) {
    if (error instanceof PathRefused) return refuse(error.message, 'refused', { path: args.path })
    throw error
  }
  const rel = posixOf(pure)
  const exists = existsSync(real)
  if (exists && !statSync(real).isFile()) return refuse(`'${rel}' is not a file`, 'refused', { path: rel })
  if (!exists && args.kind === 'edit') return refuse(`'${rel}' does not exist; write_file creates a file`, 'refused', { path: rel })
  const before = exists ? readFileSync(real) : null
  if (before !== null) {
    const current = sha256Of(before)
    if (args.expected_sha256 === null) return refuse(promptText('refusal.unread', { path: rel }), 'refused', { path: rel })
    if (args.expected_sha256 !== current) return refuse(promptText('refusal.changed', { path: rel }), 'refused', { path: rel, conflict: true })
    if (isBinary(before)) return refuse(`'${rel}' is binary; text edits only`, 'refused', { path: rel })
  }
  const text = before === null ? null : before.toString('utf8')
  let afterText: string
  let replacements: number | null = null
  if (args.kind === 'write') {
    if (args.content === null || args.content === undefined) return refuse('write_file needs `content`', 'refused', { path: rel })
    afterText = args.content
  } else {
    const oldString = args.old_string ?? ''
    if (!oldString) return refuse('old_string is required', 'refused', { path: rel })
    if (args.new_string === null || args.new_string === undefined) return refuse('new_string is required', 'refused', { path: rel })
    const occurrences = text!.split(oldString).length - 1
    if (occurrences === 0) return refuse(promptText('refusal.no_match', { path: rel }), 'refused', { path: rel })
    if (occurrences > 1 && !args.replace_all) return refuse(promptText('refusal.multiple_matches', { count: occurrences }), 'refused', { path: rel })
    afterText = args.replace_all ? text!.split(oldString).join(args.new_string) : text!.replace(oldString, () => args.new_string as string)
    replacements = args.replace_all ? occurrences : 1
  }
  // the hard locks bound the worktree; the temporary folder is outside it
  const broken = policy.isOutside(pure) ? [] : checkChange(locks, rel, text, afterText)
  if (broken.length) return refuse(broken.join('; '), 'refused_by_lock', { path: rel, locks: broken })
  const data = Buffer.from(afterText, 'utf8')
  const action = before === null ? 'created' : args.kind === 'write' ? 'overwritten' : 'edited'
  // the person's own folder: the file as it is kept first (the journal), and nothing is written if it cannot be
  const journalled = isDirect(workspace) && !policy.isOutside(pure)
  let entry = null
  if (journalled) {
    try {
      entry = workspaces.journal.prepare(workspace, { ...record, path: rel, action, before, intended: data })
    } catch (error) {
      return refuse(`'${rel}' was not written: the file as it is could not be kept first (${(error as Error).message})`, 'refused', { path: rel })
    }
  }
  if (before === null) mkdirSync(dirname(real), { recursive: true })
  // the file must still be as it was checked: a file created or rewritten meanwhile (another process) is kept, not replaced
  try {
    // a file replaced keeps its permission bits (an executable script stays executable, a private file private)
    atomicWrite(real, data, { expect: before === null ? { absent: true } : { sha256: sha256Of(before) }, keep_mode: true })
  } catch (error) {
    if (entry !== null) workspaces.journal.abandoned(entry)
    if (error instanceof WriteConflict) return refuse(promptText('refusal.changed', { path: rel }), 'refused', { path: rel, conflict: true })
    throw error
  }
  if (entry !== null) workspaces.journal.applied(entry, data)
  if (!policy.isOutside(pure)) workspaces.noteWrite(workspace)
  const diff = unifiedDiff(text ?? '', afterText, rel).slice(0, DIFF_CAP)
  const payload = { status: 'ok', path: rel, action, ...(replacements !== null ? { replacements } : {}), diff }
  return [payload, { path: rel, op: action, diff }, sha256Of(data)]
}

async function writeTool(ctx: Ctx, tool: 'write_file' | 'edit_file', args: Omit<TextWrite, 'kind' | 'expected_sha256'>): Promise<Payload> {
  const deps = ctx.deps
  const blocked = orderRefused(ctx, tool, { path: args.path })
  if (blocked !== null) return blocked
  // the folder's instructions come before the first change in it: noted now, the change waits until they are read
  let rel = args.path
  let pendingScope: string | null = null
  if (deps.workspace.target?.kind === 'ssh') {
    rel = (await deps.workspaces.requireRemoteFiles().resolve(deps.workspace, args.path, true)).path
    args = { ...args, path: rel }
    const canonicalBlocked = orderRefused(ctx, tool, { path: rel })
    if (canonicalBlocked) return canonicalBlocked
    pendingScope = await noteRemoteInstructions(ctx, rel)
  } else try {
    const [pure, real] = deps.policy.resolveWrite(args.path)
    rel = posixOf(pure)
    pendingScope = noteFolderInstructions(ctx, pure, real)
  } catch { rel = args.path }
  const held = heldForInstructions(ctx, tool, pendingScope)
  if (held !== null) return held
  const proposed = await checkActionGate(ctx as never, tool, { ...args })
  if (proposed !== null) return proposed
  const session = refreshSession(deps)
  const gate = deps.gate.check(session, 'workspace_write', { path: args.path, tool }, { run_id: deps.run_id, tool_call_id: ctx.tool_call_id })
  if (gate !== null) {
    deps.emit('action_gated', { tool, tool_call_id: ctx.tool_call_id, ...gate })
    return finish(ctx, tool, gate as unknown as Payload, { summary: gate.reason.slice(0, 200) })
  }
  const writeArgs: TextWrite = { ...args, kind: tool === 'write_file' ? 'write' : 'edit', expected_sha256: deps.seen.get(rel) ?? null }
  const record = { session_id: deps.session.id, run_id: deps.run_id, tool_call_id: ctx.tool_call_id, cancelled: deps.cancelled }
  const [payload, summary, version] = deps.workspace.target?.kind === 'ssh'
    ? await writeRemoteText(deps.workspaces, deps.workspace, deps.locks(), deps.policy.protected, writeArgs, record)
    : writeText(deps.policy, deps.workspaces, deps.workspace, deps.locks(), writeArgs, record)
  if (payload.status === 'refused_by_lock') deps.lock_refusals += 1
  if (version !== null) deps.seen.set(payload.path as string, version)
  return finish(ctx, tool, payload, summary)
}

export function writeFile(ctx: Ctx, args: { path: string; content: string }): Promise<Payload> {
  return writeTool(ctx, 'write_file', args).catch(error => remoteFileFailure(ctx, 'write_file', error))
}

export function editFile(ctx: Ctx, args: { path: string; old_string: string; new_string: string; replace_all: boolean }): Promise<Payload> {
  return writeTool(ctx, 'edit_file', args).catch(error => remoteFileFailure(ctx, 'edit_file', error))
}

register({
  name: 'read_file', effect: 'read', action: null, renderer: 'file_read', summary: 'read a file, or list a folder',
  description: PROMPT_TEXT['tool.read_file'],
  schema: z.object({
    path: z.string().describe(PROMPT_TEXT['parameter.read_file.path']),
    offset: z.number().int().default(1).describe(PROMPT_TEXT['parameter.read_file.offset']),
    limit: z.number().int().default(400).describe(PROMPT_TEXT['parameter.read_file.limit']),
  }), fn: readFile,
})
register({
  name: 'write_file', effect: 'workspace_write', action: 'workspace_write', renderer: 'patch', summary: 'create or replace a text file',
  description: PROMPT_TEXT['tool.write_file'],
  schema: z.object({
    path: z.string().describe(PROMPT_TEXT['parameter.write_file.path']),
    content: z.string().describe(PROMPT_TEXT['parameter.write_file.content']),
  }), fn: writeFile,
})
register({
  name: 'edit_file', effect: 'workspace_write', action: 'workspace_write', renderer: 'patch', summary: 'replace exact text in a file',
  description: PROMPT_TEXT['tool.edit_file'],
  schema: z.object({
    path: z.string().describe(PROMPT_TEXT['parameter.edit_file.path']),
    old_string: z.string().describe(PROMPT_TEXT['parameter.edit_file.old_string']),
    new_string: z.string().describe(PROMPT_TEXT['parameter.edit_file.new_string']),
    replace_all: z.boolean().default(false).describe(PROMPT_TEXT['parameter.edit_file.replace_all']),
  }), fn: editFile,
})

// the gate executes an approved write through this same path, against the file as it stands (the proposal's file
// fingerprint has been checked for drift by then)
for (const [tool, kind] of [['write_file', 'write'], ['edit_file', 'edit']] as const) {
  setGateHooks({ executors: { [tool]: async (host, args, ctx) => {
    if (ctx.workspace.target?.kind === 'ssh') {
      const expected = ctx.context?.remote_expected_sha256
      const [result] = await writeRemoteText(host.workspaces, ctx.workspace, ctx.locks, ctx.protected, { ...(args as Omit<TextWrite, 'kind' | 'expected_sha256'>), kind, expected_sha256: typeof expected === 'string' ? expected : null },
        { session_id: ctx.session.id, run_id: ctx.run_id, tool_call_id: ctx.tool_call_id })
      return result
    }
    // an attached folder as the session's grant holds it now (the person may have opened it after the proposal)
    const policy = PathPolicy.forWorkspace(ctx.workspace.path, ctx.protected, workspaceAttached(ctx.project, ctx.workspace, { writable: repo.getSession(host.conn, ctx.session.id)?.grants.attached_write === true }), { temp: ctx.temp, pinned: isDirect(ctx.workspace), ...rootPolicyOptionsOf(host.conn, ctx.session.id, ctx.workspace) })
    let current: string | null = null
    try { current = sha256Of(readFileSync(policy.resolveWrite(args.path as string)[1])) } catch { current = null }
    const [result] = writeText(policy, host.workspaces, ctx.workspace, ctx.locks, { ...(args as Omit<TextWrite, 'kind' | 'expected_sha256'>), kind, expected_sha256: current },
      { session_id: ctx.session.id, run_id: ctx.run_id, tool_call_id: ctx.tool_call_id })
    return result
  } } })
}
