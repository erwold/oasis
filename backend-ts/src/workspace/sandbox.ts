/** A command's confinement in a workspace (its shell, a verification's check): the working tree writable; the
 *  workspace's Git metadata readable and never written; the object views its repository reads (the base commit's,
 *  the commits shared into it) readable; nothing else of the harness data directory: not a sibling workspace's
 *  repository (its checkpoints), not a store another workspace writes to, not another project's, not the
 *  credentials beside them. Seatbelt matches real paths, so the roots are resolved here; a root that is itself a
 *  link is refused (a command may not swap the ground it stands on). */

import { lstatSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Project, Workspace } from '@oasis-code/contract'
import { regexEscape, SandboxInputRefused, type OrderBounds, type Sandbox } from '../execution/isolation.ts'
import { authorizedPaths, grantScope, type AuthorizedInputFiles } from './attachment_access.ts'
import { gitPointer } from './git.ts'
import { pinnedRoot, resolveReal, type AttachedRoot } from './paths.ts'
import { sandboxRootRules } from './roots.ts'

/** What a work order bounds for a command (with the protected paths in force): what sandboxForWorkspace renders
 *  into the kernel's rules. */
export interface OrderInput {
  read_only: boolean
  read: string[] | null
  write: string[] | null
  protected: string[]
}

/** The worktree's metadata directory in the base repository — a workspace of the earlier layout, whose `.git` file
 *  points under base.git/worktrees — or null for a repository of its own. */
export function worktreeGitDir(root: string, baseRepo: string): string | null {
  const pointer = gitPointer(root)
  if (pointer === null) return null
  const target = resolveReal(pointer)
  return target.startsWith(join(baseRepo, 'worktrees') + '/') ? target : null
}

/** A repository's own metadata directory: what its `.git` file points at, its `.git` directory, or null. */
export function ownGitDir(root: string): string | null {
  const pointer = gitPointer(root)
  if (pointer !== null) return resolveReal(pointer)
  try { return statSync(join(root, '.git')).isDirectory() ? join(root, '.git') : null } catch { return null }
}

/** The object directories a repository reads besides its own: the ones its objects/info/alternates names, and
 *  theirs in turn (git follows the chain five deep). The harness writes these files; a command only reads them. */
export function alternateObjectDirs(objectsDir: string, depth = 5): string[] {
  const out: string[] = []
  const walk = (dir: string, left: number): void => {
    if (left === 0) return
    let text: string
    try { text = readFileSync(join(dir, 'info', 'alternates'), 'utf8') } catch { return }
    for (const line of text.split('\n')) {
      const entry = line.trim()
      if (!entry || entry.startsWith('#')) continue
      const target = resolveReal(isAbsolute(entry) ? entry : resolve(dir, entry))
      if (out.includes(target)) continue
      out.push(target)
      walk(target, left - 1)
    }
  }
  walk(objectsDir, depth)
  return out
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

/** What sandboxForWorkspace takes beyond the workspace: the network, the attached folder and its grant, the work
 *  order's bounds, the files a hard lock holds — and `input_files`, the session's own uploaded attachments its commands
 *  read as exact files (only what authorizeInputFiles made of the harness's records; anything else is refused). */
export interface SandboxOptions {
  network: boolean
  attached_write?: boolean
  order?: OrderInput | null
  attached?: AttachedRoot | null
  deny_write?: string[]
  /** the session's exact input files (attachment_access.authorizeInputFiles), granted to this workspace only when it is
   *  that session's: one literal read each, nothing of their folders, never written or linked */
  input_files?: AuthorizedInputFiles | null
  /** schema v29: the session's roots as this workspace holds them (roots.ts policyRoots): `write` ones writable (their
   *  nested Git metadata not: the Sandbox's own protection), `read` ones read as any folder outside the denied places */
  roots?: readonly { path: string; access: 'read' | 'write' }[] | null
}

export function sandboxForWorkspace(dataDir: string, project: Pick<Project, 'kind' | 'source_path' | 'base_repo_path'>,
  workspace: Pick<Workspace, 'path'> & Partial<Pick<Workspace, 'kind' | 'source_mount' | 'session_id' | 'project_id'>>, opts: SandboxOptions): Sandbox {
  const box = withRoots(baseSandbox(dataDir, project, workspace, opts), opts.roots ?? null)
  const inputs = opts.input_files ?? null
  if (inputs === null) return box
  // the brand is checked, and the session: a session's files are granted to its own workspaces, no other's
  const paths = authorizedPaths(inputs)
  if (!paths.length) return box
  if (typeof workspace.session_id !== 'string' || workspace.session_id !== inputs.session_id || (workspace.project_id !== undefined && workspace.project_id !== inputs.project_id)) {
    throw new SandboxInputRefused(`the input files of session ${inputs.session_id} are not granted to a workspace of ${workspace.session_id ?? 'no session'}`)
  }
  // granted files are the harness's own sealed copies in its asset store, under this data directory (which the profile
  // denies as a whole): the grant must have been made against this very data directory and store
  const scope = grantScope(inputs)
  const data = resolveReal(dataDir)
  if (scope.data_dir !== data || !scope.store_root.startsWith(`${data}/`) || paths.some((p) => !p.startsWith(`${scope.store_root}/`))) {
    throw new SandboxInputRefused(`input files granted under ${scope.data_dir} are never granted under the data directory ${data}`)
  }
  return { ...box, exact_reads: { files: [...paths], within: [scope.store_root], data_root: data } }
}

/** A box with the session's roots added (sandboxRootRules): nothing changes without roots. */
function withRoots(box: Sandbox, roots: readonly { path: string; access: 'read' | 'write' }[] | null): Sandbox {
  if (roots === null || !roots.length) return box
  const rules = sandboxRootRules(roots.map((r) => ({ path: resolveReal(r.path), access: r.access, registered: r.access, protect_git: true })))
  if (!rules.writable.length && !rules.write_deny.length) return box
  return {
    ...box,
    writable: [...box.writable, ...rules.writable],
    write_deny: [...box.write_deny, ...rules.write_deny],
    write_deny_patterns: [...(box.write_deny_patterns ?? []), ...rules.write_deny_patterns],
    pinned: [...(box.pinned ?? []), ...rules.pinned],
  }
}

function baseSandbox(dataDir: string, project: Pick<Project, 'kind' | 'source_path' | 'base_repo_path'>, workspace: Pick<Workspace, 'path'> & Partial<Pick<Workspace, 'kind' | 'source_mount'>>,
  opts: SandboxOptions): Sandbox {
  if (isLink(workspace.path)) throw new Error(`the workspace root ${workspace.path} is a link; nothing runs in it`)
  // the person's folder is taken where it was opened, never re-resolved (a parent swapped for a link leads elsewhere)
  const direct = workspace.kind ? workspace.kind === 'direct' : project.kind === 'direct'
  const root = direct ? pinnedRoot(workspace.path) : resolveReal(workspace.path)
  const readDeny = [resolveReal(dataDir)]
  const writable = [root]
  const bounds = (repository: string[]): OrderBounds | null => {
    const o = opts.order ?? null
    if (o === null || (!o.read_only && o.read === null && o.write === null && !o.protected.length)) return null
    const attached = opts.attached ?? null
    return {
      root, read_only: o.read_only, read: o.read, write: o.write, protected: [...o.protected], repository,
      attached: attached ? { name: attached.name, root: attached.root, writable: attached.writable === true } : null,
    }
  }
  // the person's own folder, edited in place: written where it is — its Git metadata never (a pointer file's
  // repository included, and a repository nested anywhere in it: the file tools refuse any `.git` of the path, a
  // command likewise; any case, as the volume may fold it), the harness's data never read, and what the hard locks
  // hold refused before a write (`deny_write`), not found after it
  if (workspace.source_mount) {
    const source = pinnedRoot(workspace.source_mount.root)
    const gitDir = ownGitDir(root)
    const repository = gitDir ? [gitDir] : []
    return {
      writable, write_deny: [source, join(root, '.git'), ...repository, ...(opts.deny_write ?? [])],
      read_deny: readDeny, read_allow: [root, source, ...repository], pinned: [root, source],
      network: opts.network, bounds: bounds(repository), deny_hardlinks: true,
    }
  }
  if (direct) {
    const gitDir = ownGitDir(root)
    const outside = gitDir !== null && !gitDir.startsWith(root + '/') ? [gitDir] : []
    return {
      writable, write_deny: [join(root, '.git'), ...outside, ...(opts.deny_write ?? [])], write_deny_patterns: [`^${regexEscape(root)}/(.*/)?\\.[gG][iI][tT](/.*)?$`],
      read_deny: readDeny, read_allow: [root, ...outside],
      pinned: [root], network: opts.network, bounds: bounds(gitDir !== null ? [gitDir] : []),
    }
  }
  const baseRepo = resolveReal(project.base_repo_path)
  // a snapshot project's original folder is never read by a command (the copy is); an attached project's folder is
  // the thing to read — outside the writable roots, so the kernel refuses every write into it, unless the session's
  // grant attached_write opened it
  if (project.source_path && project.kind !== 'attached') readDeny.push(resolveReal(project.source_path))
  if (project.source_path && project.kind === 'attached' && opts.attached_write) writable.push(resolveReal(project.source_path))
  const linked = worktreeGitDir(root, baseRepo)
  if (linked !== null) {
    // a worktree of the earlier layout not yet taken into a repository of its own (the harness adopts one before
    // any command runs in it): its refs and config readable, the base repository's objects — the store every
    // earlier worktree of the project pinned into — not, nor its other worktrees; nothing is written
    return {
      writable, write_deny: [join(root, '.git'), baseRepo], read_deny: readDeny, read_allow: [root, baseRepo],
      read_deny_within: [join(baseRepo, 'worktrees'), join(baseRepo, 'objects')], read_allow_within: [linked], pinned: [root], network: opts.network,
      bounds: bounds([baseRepo, linked]),
    }
  }
  // a repository of the workspace's own: its metadata readable (the pointer file in the tree never written, the
  // directory outside the writable roots), the views its alternates name readable, and no more of the data
  // directory — not the base repository, not a sibling workspace's repository
  const gitDir = ownGitDir(root)
  const objects = gitDir !== null ? alternateObjectDirs(join(gitDir, 'objects')) : []
  const readAllow = [root, ...(gitDir !== null && !gitDir.startsWith(root + '/') ? [gitDir] : []), ...objects]
  return {
    writable, write_deny: [join(root, '.git'), baseRepo], read_deny: readDeny, read_allow: readAllow, pinned: [root], network: opts.network,
    bounds: bounds([...(gitDir !== null ? [gitDir] : []), ...objects, baseRepo]),
  }
}
