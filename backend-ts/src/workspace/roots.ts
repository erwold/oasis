/** A session's roots (schema v29): folders besides its working folder, each registered read or write, reached by
 *  their absolute paths by the file tools (workspace/paths.ts) and by commands (workspace/sandbox.ts). Here: what a
 *  root may be (checked when it is registered: an absolute folder that exists, outside the harness's own data, not
 *  inside the working folder), what a run in a given workspace holds of them (an isolated copy never writes one), what
 *  a command's sandbox renders for them, what a Full access command needs held on the host, and the nested
 *  repositories a checkpoint left out. */

import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Checkpoint, Project, Session, SessionRoot, Workspace } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { CREDENTIAL_READ_DENY } from '../execution/isolation.ts'
import { resolveReal, type PolicyRoot } from './paths.ts'

/** A root refused when registered: why, as a stable code, the detail and what to do instead. */
export class RootRefused extends Error {
  constructor(readonly code: string, message: string, readonly next_step: string, readonly path: string | null = null) { super(message); this.name = 'RootRefused' }
}

/** The credential stores (execution/isolation.ts CREDENTIAL_READ_DENY) as real paths under the user's home. */
export function credentialStores(): string[] {
  const home = homedir()
  return CREDENTIAL_READ_DENY.map((p) => resolveReal(p.startsWith('~/') ? join(home, p.slice(2)) : p))
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** What a registration is checked against: the harness's own folders and the session's working folder(s). */
export interface RootContext {
  /** the harness's data directory and its workspaces directory (real or not: resolved here) */
  harness_dirs: string[]
  /** the session's working folder and, for an attached project, the attached folder (a root inside one is refused) */
  working: string[]
}

/** The roots a request names, checked and resolved: each an absolute path of an existing folder, by its real path;
 *  none inside or holding the harness's data; none inside the working folder (already reached there); the same
 *  folder named once (twice with one access is the same root; with two, refused). A root inside another is allowed:
 *  the deepest root holding a path decides it (a writable output folder inside a read-only source, say). */
export function checkRoots(given: readonly { path: string; access: 'read' | 'write' }[], ctx: RootContext): SessionRoot[] {
  const out = new Map<string, SessionRoot>()
  const harness = ctx.harness_dirs.map((d) => resolveReal(d))
  const working = ctx.working.filter(Boolean).map((d) => resolveReal(d))
  for (const root of given) {
    const asked = root.path.trim()
    if (!isAbsolute(asked)) throw new RootRefused('root_not_absolute', `root ${asked} is not an absolute path`, 'name the folder by its absolute path', asked)
    let real: string
    try {
      real = realpathSync(asked)
      if (!statSync(real).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new RootRefused('root_missing', `root ${asked} is not an existing folder`, 'create the folder first (open_project with create_directory makes one), or name an existing one', asked)
    }
    for (const dir of harness) {
      if (inside(real, dir) || inside(dir, real)) {
        throw new RootRefused('root_in_harness_data', `root ${asked} (${real}) ${inside(real, dir) ? 'is inside' : 'holds'} oasis-code's own data folder ${dir}, which no session reaches`, 'name a folder that neither holds nor lies in that folder', asked)
      }
    }
    for (const store of credentialStores()) {
      if (inside(real, store)) {
        throw new RootRefused('root_credential_store', `root ${asked} is inside the credential store ${store}`, 'name a folder outside the credential stores (a root holding one is allowed; the store itself stays unread by the file tools and sandboxed commands)', asked)
      }
    }
    for (const dir of working) {
      if (inside(real, dir)) {
        throw new RootRefused('root_inside_working_folder', `root ${asked} is inside the session's working folder ${dir}, where the session already reaches it as ${relative(dir, real) || '.'}`, 'leave it out (the working folder reaches it), or open its project on that folder instead', asked)
      }
    }
    const same = out.get(real)
    if (same !== undefined && same.access !== root.access) {
      throw new RootRefused('root_conflict', `root ${real} is named twice, once ${same.access} and once ${root.access}`, 'name the folder once, with the access it is to have', asked)
    }
    out.set(real, { path: real, access: root.access })
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** The folders a session's roots are checked against (RootContext): the harness's directories, and the working
 *  folder of the session's workspace with an attached project's folder. */
export function rootContext(settings: { data_dir: string; workspaces_dir: string }, project: Pick<Project, 'kind' | 'source_path'>, workspace: Pick<Workspace, 'path'> | null): RootContext {
  const working = [...(workspace ? [workspace.path] : []), ...(project.kind === 'direct' && project.source_path ? [project.source_path] : []), ...(project.kind === 'attached' && project.source_path ? [project.source_path] : [])]
  return { harness_dirs: [settings.data_dir, settings.workspaces_dir], working }
}

/** Whether a workspace of the session is an isolated copy (not its own working folder): an interaction step's or a
 *  separate task's workspace — a folder edited in place is one workspace for every session, never a copy. */
export function isIsolatedCopy(session: Pick<Session, 'workspace_id'>, workspace: Pick<Workspace, 'id' | 'kind'>): boolean {
  return workspace.kind !== 'direct' && session.workspace_id !== null && workspace.id !== session.workspace_id
}

/** The roots a run in `workspace` holds: the session's, each as registered in its own working folder; in an isolated
 *  copy every one read-only (a copy never writes a shared folder; `registered` keeps what the session has). Git
 *  metadata in a root is kept from the file tools in a Sandbox access session only. */
export function policyRoots(session: Pick<Session, 'roots' | 'workspace_id' | 'access_mode'> | null, workspace: Pick<Workspace, 'id' | 'kind'>): PolicyRoot[] {
  if (session === null || !session.roots?.length) return []
  const copy = isIsolatedCopy(session, workspace)
  return (session.roots ?? []).map((r) => ({ path: r.path, access: copy ? 'read' : r.access, registered: r.access, protect_git: session.access_mode !== 'full' }))
}

/** policyRoots for a session read by id (a deleted or unknown session: none). */
export function policyRootsOf(conn: Conn, sessionId: string | null, workspace: Pick<Workspace, 'id' | 'kind'>): PolicyRoot[] {
  return policyRoots(sessionId ? repo.getSession(conn, sessionId) : null, workspace)
}

/** The roots a reader of a workspace through the API sees (connector read_file, the file and folder routes),
 *  read-only (those routes never write): every session's working in it — or, when `only` names the sessions the
 *  reader acts for (a native director's reach, a command's own session), theirs alone: a folder edited in place is
 *  shared by its sessions, their own roots are not. */
export function readerRoots(conn: Conn, workspace: Workspace, only: readonly string[] | null = null): PolicyRoot[] {
  const out = new Map<string, PolicyRoot>()
  for (const s of repo.sessionsOfWorkspace(conn, workspace.id)) {
    if (only !== null && !only.includes(s.id)) continue
    for (const r of policyRoots(s, workspace)) if (!out.has(r.path)) out.set(r.path, { ...r, access: 'read' })
  }
  return [...out.values()]
}

/** What a run is told of its roots, one entry each: the path, the access it has here, and — narrowed in an isolated
 *  copy — the access the session registered. */
export function effectiveRoots(roots: readonly PolicyRoot[]): { path: string; access: 'read' | 'write'; registered: 'read' | 'write' }[] {
  return [...roots].sort((a, b) => a.path.localeCompare(b.path)).map((r) => ({ path: r.path, access: r.access, registered: r.registered }))
}

/** What a sandboxed command's box adds for the roots: a read root is readable as every folder outside the denied
 *  places is (nothing is added: a credential store inside a root stays denied); a write root writable, with its nested
 *  Git metadata write-denied (the Sandbox's own protection); a read root inside a write root write-denied again. */
export function sandboxRootRules(roots: readonly PolicyRoot[]): { writable: string[]; write_deny: string[]; write_deny_patterns: string[]; pinned: string[] } {
  const writable = roots.filter((r) => r.access === 'write').map((r) => r.path)
  const readOnly = roots.filter((r) => r.access === 'read').map((r) => r.path)
  return {
    writable,
    // a read-only root under a writable one stays read-only (the deepest root decides)
    write_deny: readOnly.filter((p) => writable.some((w) => p !== w && inside(p, w))),
    write_deny_patterns: writable.map((w) => `^${w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/(.*/)?\\.[gG][iI][tT](/.*)?$`),
    pinned: writable,
  }
}

/** What a Full access command must have held for it on the host by the kernel (execution's host-restricted profile):
 *  the session's read-only roots never written — save a writable root deeper inside one. Empty: nothing to hold (the
 *  command runs on the host as it does without roots). */
export function hostRootRestrictions(roots: readonly PolicyRoot[]): { write_deny: string[]; write_allow: string[] } {
  const readOnly = roots.filter((r) => r.access === 'read').map((r) => r.path)
  const writable = roots.filter((r) => r.access === 'write').map((r) => r.path)
  return { write_deny: readOnly, write_allow: writable.filter((w) => readOnly.some((p) => w !== p && inside(w, p))) }
}

// ---- nested repositories a checkpoint leaves out ---------------------------------------------------------------------

const NESTED = / \(a git repository of its own\)$/

/** The nested repositories a snapshot's excluded rules name (GitHost.snapshotTree): workspace-relative paths. */
export function nestedRepositoriesOf(excludedRules: readonly string[]): string[] {
  return excludedRules.filter((r) => NESTED.test(r)).map((r) => r.replace(NESTED, ''))
}

/** A checkpoint with the nested repositories its tree left out (from its snapshot). */
export function withExcludedRepositories(conn: Conn, cp: Checkpoint): Checkpoint {
  const snap = repo.getSnapshot(conn, cp.snapshot_id)
  return { ...cp, excluded_nested_repositories: snap ? nestedRepositoriesOf(snap.excluded_rules) : [] }
}

/** What PathPolicy.forWorkspace takes for a session's roots in a workspace: the roots as a run there holds them and
 *  the credential stores never read inside them. */
export function rootPolicyOptions(session: Pick<Session, 'roots' | 'workspace_id' | 'access_mode'> | null, workspace: Pick<Workspace, 'id' | 'kind'>): { roots: PolicyRoot[]; root_read_deny: string[] } {
  const roots = policyRoots(session, workspace)
  return { roots, root_read_deny: roots.length ? credentialStores() : [] }
}

/** rootPolicyOptions for a session read by id. */
export function rootPolicyOptionsOf(conn: Conn, sessionId: string | null, workspace: Pick<Workspace, 'id' | 'kind'>): { roots: PolicyRoot[]; root_read_deny: string[] } {
  return rootPolicyOptions(sessionId ? repo.getSession(conn, sessionId) : null, workspace)
}

// ---- a project's folder made on request ------------------------------------------------------------------------------

/** Where a new folder of a project goes: an absolute path whose parent exists and is a folder, the parent's real path
 *  joined with the last component; the disk's root and a place inside or holding the harness's data are refused. */
function folderPlace(path: string, harnessDirs: readonly string[]): string {
  const expanded = path.startsWith('~') ? join(homedir(), path.slice(1)) : path
  if (!isAbsolute(expanded)) throw new RootRefused('path_not_absolute', `${path} is not an absolute path`, 'name the folder to make by its absolute path', path)
  const target = resolve(expanded)
  const parent = dirname(target)
  if (target === parent) throw new RootRefused('create_refused', 'the root of the disk is not made or opened as a project folder', 'name a folder inside an existing folder', path)
  let parentReal: string
  try {
    parentReal = realpathSync(parent)
    if (!statSync(parentReal).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new RootRefused('parent_missing', `the parent folder ${parent} does not exist (only the last component, ${basename(target)}, is made)`, `make ${parent} first, or name a folder whose parent exists`, path)
  }
  const real = join(parentReal, basename(target))
  for (const dir of harnessDirs.map((d) => resolveReal(d))) {
    if (inside(real, dir) || inside(dir, real)) throw new RootRefused('create_refused', `${real} ${inside(real, dir) ? 'is inside' : 'holds'} oasis-code's own data folder ${dir}`, 'name a folder outside it', path)
  }
  return real
}

/** A folder made for a project on request (open_project create_directory): the last component of an absolute path
 *  only, inside a parent that exists and is a folder — never a parent made on the way. A folder already there is
 *  taken as it is (`created: false`); anything else there is refused, as is the disk's root and a folder inside or
 *  holding the harness's data. The parent is only where the folder is made: nothing of it is opened or granted. */
export function makeProjectFolder(path: string, harnessDirs: readonly string[]): { path: string; created: boolean } {
  const real = folderPlace(path, harnessDirs)
  let existing: ReturnType<typeof lstatSync> | null = null
  try { existing = lstatSync(real) } catch { existing = null }
  if (existing !== null) {
    if (existing.isDirectory()) return { path: real, created: false }
    throw new RootRefused('not_a_directory', `${real} exists and is not a folder`, 'name another folder, or open the existing folder that holds it', path)
  }
  try { mkdirSync(real) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' && statSync(real).isDirectory()) return { path: real, created: false }
    throw new RootRefused('create_refused', `${real} could not be made (${code ?? (error as Error).message})`, 'check that the parent folder is writable, or make the folder yourself', path)
  }
  return { path: real, created: true }
}

/** The folder a new Git worktree is made in (open_project worktree): placed as a folder made on request is, and not
 *  there yet — git makes it. */
export function newWorktreeFolder(path: string, harnessDirs: readonly string[]): string {
  const real = folderPlace(path, harnessDirs)
  let there = true
  try { lstatSync(real) } catch { there = false }
  if (there) throw new RootRefused('create_refused', `${real} exists: a worktree is made in a new folder`, 'name a folder that does not exist yet, or open the existing folder by path', path)
  return real
}
