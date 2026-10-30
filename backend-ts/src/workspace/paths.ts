/** Path policy for the file tools: a path is a POSIX-relative name inside one workspace, resolved through symlinks
 *  and required to land inside the workspace's real root; the workspace's Git metadata and the configured
 *  protected globs are never written. Absolute locations reachable besides: the workspace's temporary folder and the
 *  session's roots (schema v29: folders registered read or write), each by its absolute path, and no other absolute
 *  path. The policy is checked at every call (visibility of a tool is not a permission). */

import { lstatSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { text } from '../prompt_texts.ts'

// never listed or read in bulk: the tools refuse to walk into these unless a path names one explicitly
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', 'dist', 'build', '.mypy_cache', '.ruff_cache', '.tox', '.next', 'target'])
export const MAX_FILE_BYTES = 2 * 1024 * 1024

/** The path is outside the policy; the message says why. */
export class PathRefused extends Error {
  constructor(message: string) { super(message); this.name = 'PathRefused' }
}

/** A POSIX-relative path as its parts (never empty strings). */
export type PurePath = string[]

export function posixOf(pure: PurePath): string {
  return pure.join('/')
}

/** Python's fnmatch.fnmatchcase: `*` and `?` match across `/`, `[...]` classes. */
export function fnmatchcase(name: string, pattern: string): boolean {
  let re = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      let j = i + 1
      if (j < pattern.length && pattern[j] === '!') j += 1
      if (j < pattern.length && pattern[j] === ']') j += 1
      while (j < pattern.length && pattern[j] !== ']') j += 1
      if (j >= pattern.length) re += '\\['
      else {
        let stuff = pattern.slice(i + 1, j).replace(/\\/g, '\\\\')
        i = j
        if (stuff.startsWith('!')) stuff = '^' + stuff.slice(1)
        else if (stuff.startsWith('^')) stuff = '\\' + stuff
        re += `[${stuff}]`
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&')
  }
  return new RegExp(re + '$', 's').test(name)
}

/** Whether names are compared as the host's volumes compare them: macOS formats its volumes case-insensitive (and
 *  normalization-insensitive) by default, so `.GIT/config` is `.git/config` and `TEST_CALC.PY` is `test_calc.py`.
 *  Folded on every macOS volume rather than probed per root: on a case-sensitive volume a folded match only refuses
 *  more, never less, and there is no probe to get wrong (a read-only root, a volume mounted later). */
export const FOLDED_NAMES = process.platform === 'darwin'

// HFS+ ignores these code points in a name (Git's is_hfs_dotgit strips the same): `.g‌it` is `.git` there
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g

/** A name, a relative path or a glob as the volume compares it: folded where the host's volumes fold names. */
export function foldName(name: string): string {
  return FOLDED_NAMES ? name.replace(HFS_IGNORABLE, '').normalize('NFD').toLowerCase() : name
}

/** Whether one path component names the Git metadata (`.git`, in any spelling the volume takes for it). */
export function isGitName(part: string): boolean {
  return foldName(part) === '.git'
}

/** Whether a relative path matches a glob with the file tools' meaning (fnmatchcase, and `dir/**` covering what is
 *  below `dir`), both compared as the volume names them. */
export function globMatch(path: string, pattern: string): boolean {
  const p = foldName(path)
  const g = foldName(pattern)
  return fnmatchcase(p, g) || (g.endsWith('/**') && p.startsWith(g.slice(0, -3) + '/'))
}

/** The real path of a file that may not exist yet: its deepest existing ancestor resolved, the rest appended. */
export function resolveReal(path: string): string {
  const parts: string[] = []
  let current = path
  for (;;) {
    try { return join(realpathSync(current), ...parts.reverse()) } catch { /* not there yet */ }
    const parent = resolve(current, '..')
    if (parent === current) return join(current, ...parts.reverse())
    parts.push(current.slice(parent.length).replace(/^[\\/]/, ''))
    current = parent
  }
}

/** A folder edited in place cannot be reached where it was opened (moved, offline, replaced by a link): nothing of
 *  it is read or written, and nothing of it is known. */
export class FolderUnreachable extends Error {
  constructor(message: string) { super(message); this.name = 'FolderUnreachable' }
}

/** A folder edited in place, where it was opened: its recorded real path, still a directory of its own there — not a
 *  link, and resolving to itself. A folder moved away and a link put in its place (or a parent swapped for one) would
 *  lead every tool somewhere the person never opened; it is refused, not followed (FolderUnreachable, saying why). */
export function pinnedRoot(root: string): string {
  let link: boolean
  try { link = lstatSync(root).isSymbolicLink() } catch (error) {
    throw new FolderUnreachable(`the folder ${root} cannot be reached where it was opened (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`)
  }
  if (link) throw new FolderUnreachable(`the folder ${root} is a link now, not the folder that was opened; nothing is read or written through it`)
  let real: string
  try { real = realpathSync(root) } catch (error) {
    throw new FolderUnreachable(`the folder ${root} cannot be reached where it was opened (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`)
  }
  if (real !== root) throw new FolderUnreachable(`the folder ${root} now leads to ${real}, not the folder that was opened; nothing is read or written through it`)
  return root
}

function inside(real: string, root: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** A folder attached to a workspace: mounted read-only under `name` inside the workspace (a symlink the workspace
 *  carries), its files read as they stand, never written. `root` is the folder's real path. */
export interface AttachedRoot { name: string; root: string; writable?: boolean }

/** A folder a session reaches besides its working folder (schema v29), as a run holds it: its real path, the access
 *  it has here (`read` or `write`), the access the session registered (`registered`: `write` narrowed to `read` in an
 *  isolated copy, which never writes a shared folder) and whether Git metadata under it is kept from the file tools'
 *  writes (`protect_git`: a Sandbox session's protection; a Full access session's roots are the user's own). */
export interface PolicyRoot { path: string; access: 'read' | 'write'; registered: 'read' | 'write'; protect_git: boolean }

export class PathPolicy {
  readonly root: string                        // the workspace's real root
  readonly protected: string[]                 // globs relative to the root, never written
  readonly label: string
  readonly extra_read_deny: string[]           // absolute prefixes never read
  readonly attached: AttachedRoot | null       // a second root, read-only, reached through `<name>/…`
  /** the workspace's temporary folder (a real path): reached by its absolute path, read and written */
  readonly temp: string | null
  /** the session's roots (real paths), reached by their absolute paths; the deepest root holding a path decides it */
  readonly roots: PolicyRoot[]
  /** inside a root, never read (the credential stores a root may hold: roots.ts credentialStores) */
  readonly root_read_deny: string[]

  constructor(opts: { root: string; protected?: string[]; label?: string; extra_read_deny?: string[]; attached?: AttachedRoot | null; temp?: string | null; roots?: PolicyRoot[] | null; root_read_deny?: string[] }) {
    this.root = opts.root
    this.protected = [...(opts.protected ?? [])]
    this.label = opts.label ?? 'workspace'
    this.extra_read_deny = [...(opts.extra_read_deny ?? [])]
    this.attached = opts.attached ?? null
    this.temp = opts.temp ? resolveReal(opts.temp) : null
    // deepest first: the most specific root decides a path it holds
    this.roots = [...(opts.roots ?? [])].map((r) => ({ ...r })).sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path))
    this.root_read_deny = [...(opts.root_read_deny ?? [])]
  }

  /** `pinned`: the root is a folder edited in place, taken only where it was opened (pinnedRoot), never re-resolved. */
  static forWorkspace(root: string, protectedGlobs: string[] = [], attached: AttachedRoot | null = null, opts: { temp?: string | null; pinned?: boolean; roots?: PolicyRoot[] | null; root_read_deny?: string[] } = {}): PathPolicy {
    return new PathPolicy({ root: opts.pinned ? pinnedRoot(root) : resolveReal(resolve(root)), protected: [...protectedGlobs, '.git', '.git/**'], attached, temp: opts.temp ?? null, roots: opts.roots ?? null, root_read_deny: opts.root_read_deny })
  }

  /** The root a normalized path is in (its first part is that root's absolute path), or null. */
  rootOf(pure: PurePath): PolicyRoot | null {
    if (!pure.length || !pure[0]!.startsWith('/')) return null
    return this.roots.find((r) => r.path === pure[0]) ?? null
  }

  /** Whether a normalized path is in a session root. */
  isRoot(pure: PurePath): boolean {
    return this.rootOf(pure) !== null
  }

  /** Whether a normalized path is outside the workspace's tree: the temporary folder or a session root (no journal,
   *  checkpoint, lock or folder instruction of the workspace's reaches it). */
  isOutside(pure: PurePath): boolean {
    return this.isTemp(pure) || this.isRoot(pure)
  }

  /** The deepest session root holding a real path, or null. */
  rootHolding(real: string): PolicyRoot | null {
    return this.roots.find((r) => inside(real, r.path)) ?? null
  }

  /** The name a real path has in this policy's places — the workspace's relative path, `<attached name>/…`, a session
   *  root's absolute path — so a scope is checked against what a name resolved to (a link's target), not only the name
   *  given. temp: in the temporary folder (no order's scope bounds it); path null: in none of them. */
  canonicalOf(real: string): { path: string | null; temp: boolean } {
    if (this.temp !== null && inside(real, this.temp)) return { path: null, temp: true }
    if (this.rootHolding(real) !== null) return { path: real, temp: false }
    if (inside(real, this.root)) return { path: relative(this.root, real).split(sep).join('/') || '.', temp: false }
    if (this.attached !== null && inside(real, this.attached.root)) {
      const rel = relative(this.attached.root, real).split(sep).join('/')
      return { path: rel ? `${this.attached.name}/${rel}` : this.attached.name, temp: false }
    }
    return { path: null, temp: false }
  }

  /** Whether a normalized path leads into the attached folder (`<name>` or `<name>/…`). */
  isAttached(pure: PurePath): boolean {
    return this.attached !== null && pure.length > 0 && pure[0] === this.attached.name
  }

  /** Whether a normalized path is in the temporary folder (its first part is the folder's absolute path). */
  isTemp(pure: PurePath): boolean {
    return this.temp !== null && pure.length > 0 && pure[0] === this.temp
  }

  normalize(rel: unknown): PurePath {
    if (typeof rel !== 'string' || !rel.trim()) throw new PathRefused('path is required')
    const given = rel.trim().replace(/\\/g, '/')
    if (given.startsWith('/') || (given.length > 1 && given[1] === ':')) return this.normalizeAbsolute(rel, given)
    const parts = given.split('/').filter((p) => p !== '' && p !== '.')
    if (parts.includes('..')) throw new PathRefused(`'..' is refused: '${rel}'`)
    return parts
  }

  /** An absolute path is the temporary folder's or a session root's — its parts are [the folder, ...the path below
   *  it] (the deepest root holding it) — or the working folder's, read as the relative path it names (a folder edited
   *  in place is its own real path: an agent told that path reaches it so; a snapshot's working folder is its copy, so
   *  the original's path stays outside), or nothing. */
  private normalizeAbsolute(rel: string, given: string): PurePath {
    const outside = () => new PathRefused(text('refusal.path', { path: rel }))
    if (!given.startsWith('/')) throw outside()
    const parts = given.split('/').filter((p) => p !== '' && p !== '.')
    if (parts.includes('..')) throw new PathRefused(`'..' is refused: '${rel}'`)
    const candidate = '/' + parts.join('/')
    const base = this.temp !== null && inside(candidate, this.temp) ? this.temp : this.roots.find((r) => inside(candidate, r.path))?.path ?? null
    if (base === null && inside(candidate, this.root)) return candidate === this.root ? [] : candidate.slice(this.root.length + 1).split('/')
    if (base === null) throw outside()
    const below = candidate === base ? [] : candidate.slice(base.length + 1).split('/')
    return [base, ...below]
  }

  /** [normalized relative path, real absolute path] for a read. A symlink whose target leaves the root is refused
   *  (the boundary is the real path, not the name). */
  resolveRead(rel: string): [PurePath, string] {
    const pure = this.normalize(rel)
    if (this.isTemp(pure)) {
      const real = resolveReal(join(...pure))
      if (!inside(real, this.temp!)) throw new PathRefused(`'${rel}' resolves outside the temporary folder (symlink or link boundary)`)
      return [pure, real]
    }
    const root = this.rootOf(pure)
    if (root !== null) {
      const real = resolveReal(join(...pure))
      if (!inside(real, root.path)) throw new PathRefused(`'${rel}' resolves outside the root ${root.path} (symlink or link boundary)`)
      for (const prefix of [...this.extra_read_deny, ...this.root_read_deny]) {
        if (inside(real, prefix)) throw new PathRefused(`'${rel}' is under a denied location (${prefix})`)
      }
      return [pure, real]
    }
    const candidate = pure.length ? join(this.root, ...pure) : this.root
    const real = resolveReal(candidate)
    const attachedOk = this.attached !== null && this.isAttached(pure) && inside(real, this.attached.root)
    if (!inside(real, this.root) && !attachedOk) throw new PathRefused(`'${rel}' resolves outside the ${this.label} (symlink or link boundary)`)
    for (const prefix of this.extra_read_deny) {
      if (real.startsWith(prefix)) throw new PathRefused(`'${rel}' is under a denied location`)
    }
    return [pure, real]
  }

  resolveWrite(rel: string): [PurePath, string] {
    const [pure, real] = this.resolveRead(rel)
    const root = this.rootOf(pure)
    if (root !== null) return this.resolveRootWrite(rel, pure, real, root)
    if (this.attached && !this.attached.writable) {
      let links = 0
      try { links = lstatSync(real).nlink } catch { /* a new file */ }
      if (links > 1) throw new PathRefused(`'${rel}' has hard links; a read-only source workspace only writes unaliased files`)
    }
    if (this.isTemp(pure)) {
      if (pure.length === 1) throw new PathRefused('the temporary folder itself cannot be written')
      const parentReal = resolveReal(join(...pure.slice(0, -1)))
      if (!inside(parentReal, this.temp!)) throw new PathRefused(`'${rel}': its parent directory resolves outside the temporary folder`)
      if (lstatSyncIsLink(join(...pure))) throw new PathRefused(`'${rel}' is a symbolic link; tools write regular files only`)
      return [pure, real]
    }
    const posix = posixOf(pure)
    if (!posix) throw new PathRefused('the root itself cannot be written')
    const attached = this.attached !== null && this.isAttached(pure)
    if (attached && !this.attached!.writable) {
      throw new PathRefused(`'${rel}' is in the attached folder ${this.attached!.name}/, which is read as it stands and never written; write into the ${this.label} itself`)
    }
    if (attached && pure.length === 1) throw new PathRefused(`'${rel}' is the attached folder itself; write inside it`)
    // the ancestors must stay inside too (a symlinked parent directory is a boundary) — inside the attached folder when
    // the session's grant opened it
    const parentReal = pure.length > 1 ? resolveReal(join(this.root, ...pure.slice(0, -1))) : this.root
    const parentOk = attached ? inside(parentReal, this.attached!.root) : inside(parentReal, this.root)
    if (!parentOk) throw new PathRefused(`'${rel}': its parent directory resolves outside the ${this.label}`)
    // the name as given and the path it lands on: a symlinked directory inside the root (`g -> .git`) names the same
    // file under another name
    const landed = !attached && inside(real, this.root) && real !== this.root ? relative(this.root, real).split(sep) : []
    if (pure.some(isGitName) || landed.some(isGitName)) throw new PathRefused(`'${rel}': Git metadata is never written by a tool`)
    const names = landed.length ? [posix, landed.join('/')] : [posix]
    for (const pattern of this.protected) {
      const stripped = pattern.replace(/[/*]+$/, '')
      if (names.some((name) => globMatch(name, pattern) || globMatch(name, stripped))) {
        throw new PathRefused(`'${rel}' is a protected path (${pattern}); the session's grant does not cover it`)
      }
    }
    if (candidateIsSymlink(this.root, pure)) throw new PathRefused(`'${rel}' is a symbolic link; tools write regular files only`)
    return [pure, real]
  }

  /** A write into a session root: a root registered `write` (and so held here), never the root itself; the parent and
   *  the file landed on held by a writable root too (a link into a read-only root, or out of every root, is refused);
   *  Git metadata only where the root keeps it (`protect_git`); a link itself never written. */
  private resolveRootWrite(rel: string, pure: PurePath, real: string, root: PolicyRoot): [PurePath, string] {
    const readOnly = (where: PolicyRoot) => new PathRefused(where.registered === 'write'
      ? `'${rel}' is in the root ${where.path}, which is read-only in this workspace (an isolated copy reads the session's roots and writes none of them); write it from the session's own working folder`
      : `'${rel}' is in the root ${where.path}, which the session reaches read-only; the person changes a root's access in oasis-code`)
    if (root.access !== 'write') throw readOnly(root)
    if (pure.length === 1) throw new PathRefused(`'${rel}' is the root ${root.path} itself; write inside it`)
    const parentReal = resolveReal(join(...pure.slice(0, -1)))
    const parentRoot = this.rootHolding(parentReal)
    if (parentRoot === null) throw new PathRefused(`'${rel}': its parent directory resolves outside the session's roots`)
    if (parentRoot.access !== 'write') throw readOnly(parentRoot)
    const landedRoot = this.rootHolding(real)
    if (landedRoot === null) throw new PathRefused(`'${rel}' resolves outside the session's roots`)
    if (landedRoot.access !== 'write') throw readOnly(landedRoot)
    if (root.protect_git || landedRoot.protect_git) {
      const landed = real === landedRoot.path ? [] : relative(landedRoot.path, real).split(sep)
      if (pure.slice(1).some(isGitName) || landed.some(isGitName)) {
        throw new PathRefused(`'${rel}': Git metadata in a root is not written by a tool in a Sandbox access session; a Full access session writes it`)
      }
    }
    if (lstatSyncIsLink(join(...pure))) throw new PathRefused(`'${rel}' is a symbolic link; tools write regular files only`)
    return [pure, real]
  }

  isSkippedDir(pure: PurePath): boolean {
    return pure.some((part) => SKIP_DIRS.has(part))
  }
}

export function candidateIsSymlink(root: string, pure: PurePath): boolean {
  return lstatSyncIsLink(join(root, ...pure))
}

function lstatSyncIsLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}
